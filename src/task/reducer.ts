import {
  CONTROL_BLOCKED,
  EVENT_CONFLICT,
  FusionError,
  REVIEW_RESULT_CONFLICT,
  REVIEW_TICKET_REQUIRED,
  REVISION_STALE,
  WORK_ORDER_CONFLICT,
} from '../errors.js'
import type {
  ControlState,
  FusionEvent,
  LogicalApproval,
  Phase,
  ReviewGate,
  ReviewResultV2,
  WorkerReport,
} from '../contracts.js'
import { TERMINAL_PHASES } from '../contracts.js'
import { digestOf } from '../digest.js'
import { assertCurrentSubject, reportSubject, reviewReadinessReceipt, sameSubject } from '../review/ticket.js'
import type { TaskState } from './state.js'

const WAITING: ReadonlySet<Phase> = new Set([
  'WAITING_APPROVAL',
  'WAITING_USER',
  'WAITING_BUDGET',
  'RECOVERING',
  'PAUSED',
  'STOPPING',
  'NEEDS_DECISION',
])

function initialControl(): ControlState {
  return {
    mode: 'running',
    pendingApprovalIds: [],
    budgetBlocked: false,
    recovering: false,
    outcomeUnknown: false,
  }
}

function waiting(state: TaskState, phase: Phase): TaskState {
  return { ...state, resumePhase: WAITING.has(state.phase) ? state.resumePhase : state.phase, phase }
}

function resume(state: TaskState, fallback: Phase): TaskState {
  return { ...state, phase: state.resumePhase ?? fallback, resumePhase: undefined }
}

function patchControl(state: TaskState, patch: Partial<ControlState>): ControlState {
  return { ...state.control, ...patch }
}

/** Releasing one gate never releases another; late review results remain actionable. */
function projectReleasedControl(state: TaskState): TaskState {
  const control = state.control
  if (control.mode !== 'running') return state
  if (control.pendingApprovalIds.length) return { ...state, phase: 'WAITING_APPROVAL' }
  if (control.outcomeUnknown || state.outcomeUnknown) return { ...state, phase: 'NEEDS_DECISION' }
  if (control.recovering) return { ...state, phase: 'RECOVERING' }
  if (control.budgetBlocked) return { ...state, phase: 'WAITING_BUDGET' }
  if (state.reviewResult) {
    const decision = state.reviewResult.decision
    return {
      ...state, resumePhase: undefined,
      phase: decision === 'rework' ? 'REWORK'
        : decision === 'accept' && state.reviewResult.protocolValid ? 'REVIEWING' : 'NEEDS_DECISION',
    }
  }
  return resume(state, state.intent === 'DIRECT' ? 'DIRECT' : 'PLANNING')
}

function requireReconciliation(state: TaskState, evidenceRef: string): void {
  if (!evidenceRef.trim() || writerBusy(state)) {
    throw new FusionError(CONTROL_BLOCKED, 'reconciliation requires evidence and a quiescent writer')
  }
}

function applyPayload(state: TaskState | undefined, event: FusionEvent): TaskState {
  switch (event.type) {
    case 'task/created':
      if (state) throw new FusionError(EVENT_CONFLICT, 'task already exists')
      if (event.seq !== 1) throw new FusionError(EVENT_CONFLICT, 'task/created must be seq 1')
      return {
        schemaVersion: 1,
        taskId: event.taskId,
        revision: event.revision,
        seq: event.seq,
        phase: 'READY',
        parent: event.payload.parent,
        selection: event.payload.selection,
        verification: 'unverified',
        pendingApprovalIds: [],
        pendingApprovals: {},
        control: initialControl(),
        outcomeUnknown: false,
        reviewGeneration: 0,
        ignoredReviewResults: [],
        staleValidations: [],
        appliedEventIds: [event.id],
      }
    case 'requirements/revised':
      return resetReviewForNewSubject({
        ...need(state, event),
        revision: event.revision,
        phase: state!.phase === 'READY' ? 'PLANNING' : state!.phase,
      })
    case 'profile/frozen':
      return applyProfileFrozen(state, event)
    case 'intent/chosen':
      return {
        ...need(state, event),
        intent: event.payload.intent,
        phase: event.payload.intent === 'DIRECT' ? 'DIRECT' : 'PLANNING',
      }
    case 'work-order/prepared':
      return applyWorkOrderPrepared(state, event)
    case 'work-order/acceptance-amended': {
      // Only the Lead amends its own frozen checks. Earlier reports were
      // verified against the old plans, so no review may carry over.
      const next = need(state, event), order = next.currentWorkOrder
      if (!order || order.mode === 'explore' || order.id !== event.payload.workOrderId || next.lease) {
        throw new FusionError(WORK_ORDER_CONFLICT, 'Acceptance amendment requires the current quiescent implementation work order')
      }
      return resetReviewForNewSubject({ ...next, currentWorkOrder: { ...order, acceptance: event.payload.acceptance } })
    }
    case 'work-order/scope-expanded': {
      // Only the Lead widens its own frozen scope, and only by adding paths.
      const next = need(state, event), order = next.currentWorkOrder
      if (!order || order.mode === 'explore' || order.mode === 'text' || order.id !== event.payload.workOrderId || next.lease
        || order.allowedPaths.some(path => !event.payload.allowedPaths.includes(path))) {
        throw new FusionError(WORK_ORDER_CONFLICT, 'Scope expansion requires the current quiescent implementation work order and keeps every allowed path')
      }
      return resetReviewForNewSubject({ ...next, currentWorkOrder: { ...order, allowedPaths: event.payload.allowedPaths } })
    }
    case 'child/accepted':
      return {
        ...need(state, event),
        exploration: state?.currentWorkOrder?.mode === 'explore' ? undefined : state?.exploration,
        acceptedChild: event.payload.child,
        acceptedMessageId: event.payload.messageId,
        phase: 'WORKER_RUNNING',
      }
    case 'child/claimed':
      return { ...need(state, event), phase: 'WORKER_RUNNING' }
    case 'exploration/recorded': {
      const next = need(state, event), report = event.payload.report, order = next.currentWorkOrder
      assertControlAllowsExecution(next)
      if (order?.mode !== 'explore' || order.id !== report.workOrderId || order.revision !== report.revision
        || next.revision !== report.revision || order.baseSnapshot !== report.snapshot || next.lease) {
        throw new FusionError(EVENT_CONFLICT, 'Exploration requires the current read-only work order and unchanged snapshot')
      }
      return { ...next, exploration: report, phase: 'PLANNING', lastSnapshot: report.snapshot }
    }
    case 'report/submitted':
      return applySubmittedReport(state, event)
    case 'report/validated':
      return applyValidatedReport(state, event)
    case 'review/requested':
      return applyReviewRequested(state, event)
    case 'review/completed':
      return applyReviewCompleted(state, event)
    case 'lease/acquired':
      return { ...need(state, event), lease: event.payload.lease }
    case 'lease/released':
      return { ...need(state, event), lease: undefined }
    case 'approval/pending':
      return applyApprovalPending(state, event)
    case 'approval/answered':
      return applyApprovalAnswered(state, event)
    case 'budget/blocked':
      return {
        ...waiting(need(state, event), 'WAITING_BUDGET'),
        control: patchControl(need(state, event), { budgetBlocked: true }),
      }
    case 'budget/unblocked': {
      const next = need(state, event)
      if (!event.payload.authorizationId.trim()) throw new FusionError(CONTROL_BLOCKED, 'budget authorization is required')
      return projectReleasedControl({ ...next, control: patchControl(next, { budgetBlocked: false }) })
    }
    case 'checkpoint/committed':
      return { ...need(state, event), lastSnapshot: event.payload.checkpoint.snapshot }
    case 'recovery/needed':
      return {
        ...waiting(need(state, event), 'RECOVERING'),
        control: patchControl(need(state, event), { recovering: true }),
      }
    case 'recovery/reconciled': {
      const next = need(state, event)
      requireReconciliation(next, event.payload.evidenceRef)
      return projectReleasedControl({ ...next, lastSnapshot: event.payload.snapshot, control: patchControl(next, { recovering: false }) })
    }
    case 'effect/outcome-unknown':
      return {
        ...waiting(need(state, event), 'NEEDS_DECISION'),
        outcomeUnknown: true,
        control: patchControl(need(state, event), { outcomeUnknown: true }),
      }
    case 'effects/reconciled': {
      const next = need(state, event)
      requireReconciliation(next, event.payload.evidenceRef)
      if (event.payload.quiescent !== true) throw new FusionError(CONTROL_BLOCKED, 'effects are not quiescent')
      return projectReleasedControl({
        ...next, outcomeUnknown: false, lastSnapshot: event.payload.snapshot,
        control: patchControl(next, { outcomeUnknown: false }),
      })
    }
    case 'task/stop-requested':
      return {
        ...waiting(need(state, event), 'STOPPING'),
        control: patchControl(need(state, event), { mode: 'stop-requested' }),
      }
    case 'task/paused':
      return {
        ...waiting(need(state, event), 'PAUSED'),
        control: patchControl(need(state, event), { mode: 'paused' }),
      }
    case 'task/resumed': {
      const next = need(state, event)
      if (next.control.mode !== 'paused' || writerBusy(next)) {
        throw new FusionError(CONTROL_BLOCKED, 'only a quiescent paused task can resume')
      }
      return projectReleasedControl({ ...next, control: patchControl(next, { mode: 'running' }) })
    }
    case 'task/completed':
      return complete(need(state, event), event)
    case 'task/cancelled':
      return {
        ...need(state, event),
        phase: 'CANCELLED',
        control: patchControl(need(state, event), { mode: 'cancelled' }),
      }
    default:
      return assertNever(event)
  }
}

function need(state: TaskState | undefined, event: FusionEvent): TaskState {
  if (!state) throw new FusionError(EVENT_CONFLICT, `${event.type} requires an existing task`)
  if (state.taskId !== event.taskId) throw new FusionError(EVENT_CONFLICT, 'taskId mismatch')
  if (event.seq !== state.seq + 1) throw new FusionError(EVENT_CONFLICT, `expected seq ${state.seq + 1}, got ${event.seq}`)
  if (event.revision < 1) throw new FusionError(EVENT_CONFLICT, 'revision must be >= 1')
  if (TERMINAL_PHASES.has(state.phase) && event.type !== 'task/cancelled') {
    throw new FusionError(EVENT_CONFLICT, `terminal phase ${state.phase} rejects ${event.type}`)
  }
  return { ...state, seq: event.seq, revision: Math.max(state.revision, event.revision), appliedEventIds: [...state.appliedEventIds, event.id] }
}

function rejectStaleReport(state: TaskState | undefined, reportRevision: number): void {
  if (state && reportRevision < state.revision) {
    throw new FusionError(REVISION_STALE, `report revision ${reportRevision} cannot advance task revision ${state.revision}`)
  }
}

function reportDigest(report: WorkerReport) {
  return digestOf(report)
}

function blockingGate(gate: ReviewGate | undefined): boolean {
  return gate !== undefined && gate.terminalStatus !== 'accepting'
}

function resetReviewForNewSubject(state: TaskState): TaskState {
  return {
    ...state,
    candidateReport: undefined,
    validatedReport: undefined,
    validatedReceipt: undefined,
    activeReviewTicket: undefined,
    reviewResult: undefined,
    reviewResultDigest: undefined,
    acceptedReview: undefined,
    lastReport: undefined,
    reviewGate: undefined,
    reviewGeneration: state.reviewGeneration + 1,
  }
}

function applyProfileFrozen(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'profile/frozen' }>,
): TaskState {
  const next = need(state, event)
  const updated: TaskState = {
    ...next,
    profileDigest: event.payload.digest,
    phase: next.phase === 'READY' ? 'PLANNING' : next.phase,
  }
  if (next.candidateReport || next.validatedReport || next.activeReviewTicket || next.acceptedReview) {
    return resetReviewForNewSubject(updated)
  }
  return updated
}

function applyWorkOrderPrepared(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'work-order/prepared' }>,
): TaskState {
  const next = need(state, event)
  const incoming = event.payload.order
  const current = next.currentWorkOrder
  if (current && current.taskId === incoming.taskId && current.id === incoming.id && current.revision === incoming.revision) {
    if (digestOf(current) !== digestOf(incoming)) {
      throw new FusionError(WORK_ORDER_CONFLICT, 'same work-order identity cannot change its frozen digest')
    }
    return { ...next, currentWorkOrder: incoming, reservedChild: event.payload.reservedChild, phase: 'PLANNING' }
  }
  const reset = current || next.candidateReport || next.validatedReport || next.activeReviewTicket || next.acceptedReview
    ? resetReviewForNewSubject(next)
    : next
  return {
    ...reset,
    currentWorkOrder: incoming,
    reservedChild: event.payload.reservedChild,
    phase: 'PLANNING',
  }
}

function applySubmittedReport(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'report/submitted' }>,
): TaskState {
  rejectStaleReport(state, event.payload.report.revision)
  const next = need(state, event)
  const incoming = event.payload.report
  if (next.currentWorkOrder?.mode === 'explore') throw new FusionError(EVENT_CONFLICT, 'Exploration cannot submit an implementation report')
  if (next.candidateReport && reportDigest(next.candidateReport) === reportDigest(incoming)) {
    return { ...next, candidateReport: incoming, lastReport: next.validatedReport ?? incoming }
  }
  const reset = resetReviewForNewSubject(next)
  return {
    ...reset,
    candidateReport: incoming,
    lastReport: incoming,
    phase: next.phase === 'WORKER_RUNNING' || next.phase === 'REVIEWING' || next.phase === 'REWORK' ? 'WORKER_RUNNING' : next.phase,
  }
}

function applyValidatedReport(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'report/validated' }>,
): TaskState {
  rejectStaleReport(state, event.payload.report.revision)
  const next = need(state, event)
  const incoming = event.payload.report
  const digest = reportDigest(incoming)
  const subject = reportSubject(next.taskId, incoming)
  const receipt = reviewReadinessReceipt(subject)
  const sameValidated = next.validatedReport !== undefined && reportDigest(next.validatedReport) === digest
  const sameCandidate = next.candidateReport !== undefined && reportDigest(next.candidateReport) === digest
  const sameWork = next.currentWorkOrder
    && incoming.workOrderId === next.currentWorkOrder.id
    && incoming.revision === next.currentWorkOrder.revision

  if (!sameCandidate || !sameWork) {
    return {
      ...next,
      staleValidations: [...next.staleValidations, { reportDigest: digest, reason: 'stale-validation' }],
    }
  }
  if (sameValidated && blockingGate(next.reviewGate)) {
    return { ...next, lastReport: incoming, validatedReport: incoming, validatedReceipt: receipt }
  }
  return {
    ...next,
    lastReport: incoming,
    validatedReport: incoming,
    validatedReceipt: receipt,
    phase: businessPhaseForReview(next),
  }
}

function businessPhaseForReview(state: TaskState): Phase {
  if (state.control.mode !== 'running') return state.phase
  if (state.control.pendingApprovalIds.length) return 'WAITING_APPROVAL'
  if (state.control.budgetBlocked) return 'WAITING_BUDGET'
  if (state.control.recovering) return 'RECOVERING'
  if (state.control.outcomeUnknown) return 'NEEDS_DECISION'
  return 'REVIEWING'
}

function applyReviewRequested(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'review/requested' }>,
): TaskState {
  const next = need(state, event)
  assertControlAllowsExecution(next)
  const receipt = next.validatedReceipt
  if (!receipt || !next.validatedReport) {
    throw new FusionError(EVENT_CONFLICT, 'review/requested requires a validated report')
  }
  const ticket = event.payload.ticket
  const actualSnapshot = next.lastSnapshot ?? ticket.subject.snapshot
  assertCurrentSubject(next, ticket, actualSnapshot)
  if (!sameSubject(ticket.subject, receipt.subject)) {
    throw new FusionError(EVENT_CONFLICT, 'review ticket subject does not match the validated report')
  }
  if (ticket.validationDigest !== digestOf(receipt)) {
    throw new FusionError(EVENT_CONFLICT, 'review ticket validation digest does not match readiness receipt')
  }
  if (ticket.generation !== next.reviewGeneration + 1 && next.activeReviewTicket && digestOf(next.activeReviewTicket) === digestOf(ticket)) {
    return next
  }
  if (ticket.generation !== next.reviewGeneration + 1) {
    throw new FusionError(EVENT_CONFLICT, `review ticket generation ${ticket.generation} is not the next generation ${next.reviewGeneration + 1}`)
  }
  return {
    ...next,
    activeReviewTicket: ticket,
    reviewGeneration: ticket.generation,
    reviewResult: undefined,
    reviewResultDigest: undefined,
    acceptedReview: undefined,
    reviewGate: undefined,
    phase: 'REVIEWING',
  }
}

function applyReviewCompleted(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'review/completed' }>,
): TaskState {
  const next = need(state, event)
  const binding = event.payload.binding
  if (!binding) {
    return applyLegacyReviewDecision(next, event)
  }
  return applyBoundReviewResult(next, binding, event)
}

function applyLegacyReviewDecision(
  state: TaskState,
  event: Extract<FusionEvent, { type: 'review/completed' }>,
): TaskState {
  const decision = event.payload.decision
  if (decision === 'accept') {
    return {
      ...state,
      reviewGate: state.lastReport
        ? {
            taskId: state.taskId,
            workOrderId: state.currentWorkOrder?.id ?? state.lastReport.workOrderId,
            revision: state.lastReport.revision,
            reportDigest: reportDigest(state.lastReport),
            snapshot: state.lastReport.snapshot,
            reviewAttemptId: event.id,
            decision,
            terminalStatus: 'legacy-unbound',
          }
        : state.reviewGate,
    }
  }
  if (!state.lastReport) {
    throw new FusionError(EVENT_CONFLICT, 'review/completed requires a validated report')
  }
  const gate: ReviewGate = {
    taskId: state.taskId,
    workOrderId: state.currentWorkOrder?.id ?? state.lastReport.workOrderId,
    revision: state.lastReport.revision,
    reportDigest: reportDigest(state.lastReport),
    snapshot: state.lastReport.snapshot,
    reviewAttemptId: event.id,
    decision,
    terminalStatus: decision === 'rework'
      ? 'rework'
      : decision === 'REVIEW_INCOMPLETE'
        ? 'incomplete'
        : 'needs-decision',
  }
  if (decision === 'rework') return { ...state, reviewGate: gate, phase: 'REWORK' }
  return { ...state, reviewGate: gate, phase: 'NEEDS_DECISION' }
}

function applyBoundReviewResult(state: TaskState, result: ReviewResultV2, event: Extract<FusionEvent, { type: 'review/completed' }>): TaskState {
  const ticket = state.activeReviewTicket
  if (
    !ticket
    || ticket.id !== result.ticketId
    || ticket.requestId !== result.requestId
    || ticket.generation !== result.generation
    || !sameSubject(ticket.subject, result.subject)
  ) {
    return { ...state, ignoredReviewResults: [...state.ignoredReviewResults, result] }
  }
  const resultDigest = digestOf(result)
  if (state.reviewResultDigest) {
    if (state.reviewResultDigest !== resultDigest) {
      throw new FusionError(REVIEW_RESULT_CONFLICT, 'conflicting review result for the same ticket')
    }
    return state
  }
  const accepts = result.protocolValid && result.decision === 'accept'
  const gate: ReviewGate = {
    taskId: state.taskId,
    workOrderId: ticket.subject.workOrderId,
    revision: ticket.subject.revision,
    reportDigest: ticket.subject.reportDigest,
    snapshot: ticket.subject.snapshot,
    reviewAttemptId: event.id,
    decision: result.decision,
    terminalStatus: accepts
      ? 'accepting'
      : result.decision === 'rework'
        ? 'rework'
        : result.decision === 'REVIEW_INCOMPLETE'
          ? 'incomplete'
          : 'needs-decision',
  }
  const recorded: TaskState = {
    ...state,
    reviewResult: result,
    reviewResultDigest: resultDigest,
    acceptedReview: accepts ? { ticket, resultDigest } : undefined,
    reviewGate: gate,
  }
  if (state.control.mode !== 'running' || state.control.pendingApprovalIds.length
    || state.control.budgetBlocked || state.control.recovering || state.control.outcomeUnknown) {
    return recorded
  }
  if (result.decision === 'rework') return { ...recorded, phase: 'REWORK' }
  if (result.decision === 'needs-decision' || result.decision === 'REVIEW_INCOMPLETE') {
    return { ...recorded, phase: 'NEEDS_DECISION' }
  }
  return { ...recorded, phase: 'REVIEWING' }
}

function applyApprovalPending(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'approval/pending' }>,
): TaskState {
  const next = need(state, event)
  const approval = event.payload.approval
  const pendingApprovalIds = [...new Set([...next.pendingApprovalIds, approval.id])]
  return {
    ...waiting(next, 'WAITING_APPROVAL'),
    pendingApprovalIds,
    pendingApprovals: { ...next.pendingApprovals, [approval.id]: approval },
    control: patchControl(next, { pendingApprovalIds }),
  }
}

function applyApprovalAnswered(
  state: TaskState | undefined,
  event: Extract<FusionEvent, { type: 'approval/answered' }>,
): TaskState {
  const next = need(state, event)
  const existing = next.pendingApprovals[event.payload.approvalId]
  if (!existing || !next.pendingApprovalIds.includes(event.payload.approvalId)) {
    throw new FusionError(EVENT_CONFLICT, `approval ${event.payload.approvalId} is not pending`)
  }
  const pendingApprovalIds = next.pendingApprovalIds.filter(id => id !== event.payload.approvalId)
  const pendingApprovals = { ...next.pendingApprovals }
  delete pendingApprovals[event.payload.approvalId]
  const control = patchControl(next, { pendingApprovalIds })
  if (event.payload.state !== 'approved') {
    return {
      ...next,
      pendingApprovalIds,
      pendingApprovals,
      control: { ...control, mode: 'paused' },
      phase: pendingApprovalIds.length ? 'WAITING_APPROVAL' : 'NEEDS_DECISION',
    }
  }
  return projectReleasedControl({ ...next, pendingApprovalIds, pendingApprovals, control })
}

function currentSnapshot(state: TaskState) {
  return state.lastSnapshot ?? state.validatedReport?.snapshot ?? state.candidateReport?.snapshot ?? state.lastReport?.snapshot
}

function writerBusy(state: TaskState): boolean {
  return Boolean(state.lease && state.lease.activeOperationIds.length > 0)
}

function assertControlAllowsExecution(state: TaskState): void {
  if (state.control.mode !== 'running') {
    throw new FusionError(CONTROL_BLOCKED, `control mode ${state.control.mode} blocks execution`)
  }
  if (state.control.pendingApprovalIds.length) {
    throw new FusionError(CONTROL_BLOCKED, 'pending human approval blocks execution')
  }
  if (state.control.outcomeUnknown || state.outcomeUnknown) {
    throw new FusionError(EVENT_CONFLICT, 'cannot complete while an effect is OUTCOME_UNKNOWN')
  }
  if (state.control.budgetBlocked || state.control.recovering) {
    throw new FusionError(CONTROL_BLOCKED, 'budget or recovery gate is still set')
  }
  if (writerBusy(state)) {
    throw new FusionError(CONTROL_BLOCKED, 'an active write lease blocks execution')
  }
}

function assertAcceptingReview(state: TaskState, event: Extract<FusionEvent, { type: 'task/completed' }>): void {
  if (state.intent === 'DIRECT') return
  if (event.payload.verification !== 'verified') {
    throw new FusionError(EVENT_CONFLICT, 'delegated downgrade must not use ordinary verified completion')
  }
  const accepted = state.acceptedReview
  const ticket = state.activeReviewTicket
  const validated = state.validatedReport
  const candidate = state.candidateReport
  const receipt = state.validatedReceipt
  if (!accepted || !ticket || !validated || !candidate || !receipt) {
    throw new FusionError(REVIEW_TICKET_REQUIRED, 'delegated task cannot complete before a bound accepting review')
  }
  const actualSnapshot = state.lastSnapshot ?? accepted.ticket.subject.snapshot
  assertCurrentSubject(state, accepted.ticket, actualSnapshot)
  if (digestOf(accepted.ticket) !== digestOf(ticket) || accepted.ticket.generation !== state.reviewGeneration) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review is stale for the current generation')
  }
  if (!sameSubject(accepted.ticket.subject, reportSubject(state.taskId, candidate))) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review does not match the current candidate')
  }
  if (!sameSubject(accepted.ticket.subject, reportSubject(state.taskId, validated))) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review does not match the current validated report')
  }
  if (accepted.ticket.validationDigest !== digestOf(receipt)) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review validation receipt changed')
  }
  if (!state.reviewResult || digestOf(state.reviewResult) !== accepted.resultDigest) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review result changed')
  }
  if (!state.reviewResult.protocolValid || state.reviewResult.decision !== 'accept') {
    throw new FusionError(EVENT_CONFLICT, 'review result is not an accepting decision')
  }
  const snapshot = currentSnapshot(state)
  if (!snapshot || accepted.ticket.subject.snapshot !== snapshot) {
    throw new FusionError(EVENT_CONFLICT, 'accepting review snapshot is not the current workspace snapshot')
  }
  if (event.payload.snapshot !== snapshot) {
    throw new FusionError(EVENT_CONFLICT, 'completion snapshot is not the current workspace snapshot')
  }
}

function complete(state: TaskState, event: Extract<FusionEvent, { type: 'task/completed' }>): TaskState {
  if (event.revision < state.revision) {
    throw new FusionError(REVISION_STALE, 'old revision cannot complete a newer task')
  }
  assertControlAllowsExecution(state)
  if (state.outcomeUnknown || state.control.outcomeUnknown) {
    throw new FusionError(EVENT_CONFLICT, 'cannot complete while an effect is OUTCOME_UNKNOWN')
  }
  if (state.phase !== 'REVIEWING' && state.phase !== 'DIRECT') {
    throw new FusionError(EVENT_CONFLICT, `cannot complete from ${state.phase}`)
  }
  if (event.payload.verification === 'verified') {
    assertAcceptingReview(state, event)
  } else if (state.intent !== 'DIRECT') {
    throw new FusionError(EVENT_CONFLICT, 'delegated downgrade must use an explicit fallback event, not ordinary completion')
  }
  return {
    ...state,
    phase: 'COMPLETED',
    verification: event.payload.verification,
    lastSnapshot: event.payload.snapshot,
    control: patchControl(state, { mode: 'completed' }),
  }
}

function assertNever(event: never): never {
  throw new FusionError(EVENT_CONFLICT, `unknown event ${(event as FusionEvent).type}`)
}

export function reduce(state: TaskState | undefined, event: FusionEvent): TaskState {
  if (event.schemaVersion !== 1) throw new FusionError(EVENT_CONFLICT, `unsupported schemaVersion ${event.schemaVersion}`)
  if (state?.appliedEventIds.includes(event.id)) return state
  return applyPayload(state, event)
}

export function reduceAll(events: readonly FusionEvent[]): TaskState {
  let state: TaskState | undefined
  for (const event of events) state = reduce(state, event)
  if (!state) throw new FusionError(EVENT_CONFLICT, 'no events')
  return state
}

export { assertControlAllowsExecution }
