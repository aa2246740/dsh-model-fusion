import type {
  FusionEvent,
  OutboxRow,
  ReportSubject,
  ReviewReadinessReceipt,
  ReviewResultV2,
  ReviewTicket,
  TaskId,
  WorkerReport,
} from '../contracts.js'
import { OperationId } from '../contracts.js'
import { digestOf } from '../digest.js'
import { EVENT_CONFLICT, FusionError } from '../errors.js'
import type { ReviewClassification } from './protocol.js'
import { toReducerReviewDecision } from './protocol.js'
import type { TaskState } from '../task/state.js'

function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new FusionError(EVENT_CONFLICT, code)
}

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value as Readonly<T>
}

export function reportSubject(taskId: TaskId, report: WorkerReport): ReportSubject {
  const reportDigest = digestOf(report)
  return {
    taskId,
    workOrderId: report.workOrderId,
    revision: report.revision,
    reportId: `report:${reportDigest}`,
    reportDigest,
    snapshot: report.snapshot,
  }
}

export function sameSubject(left: ReportSubject, right: ReportSubject): boolean {
  return digestOf(left) === digestOf(right)
}

export function reviewReadinessReceipt(subject: ReportSubject): ReviewReadinessReceipt {
  const receipt = {
    subject,
    receiptId: `ready:${subject.reportDigest}`,
    verdict: 'review-ready' as const,
    receiptDigest: '' as ReviewReadinessReceipt['receiptDigest'],
  }
  return { ...receipt, receiptDigest: digestOf({ subject, receiptId: receipt.receiptId, verdict: receipt.verdict }) }
}

export function captureTicket(ticket: ReviewTicket): Readonly<ReviewTicket> {
  requireThat(ticket.id && ticket.requestId && Number.isSafeInteger(ticket.generation), 'INVALID_TICKET')
  requireThat(ticket.workOrderDigest, 'WORK_ORDER_DIGEST_REQUIRED')
  return freeze(structuredClone(ticket))
}

export function createReviewTicket(
  state: TaskState,
  ids: { ticketId: string; requestId: string },
): ReviewTicket {
  const receipt = state.validatedReceipt
  const workOrder = state.currentWorkOrder
  if (!receipt) throw new FusionError(EVENT_CONFLICT, 'review ticket requires a validated report')
  if (!workOrder) throw new FusionError(EVENT_CONFLICT, 'review ticket requires a current work order')
  return captureTicket({
    id: ids.ticketId,
    requestId: ids.requestId,
    generation: state.reviewGeneration + 1,
    subject: receipt.subject,
    validationDigest: digestOf(receipt),
    workOrderDigest: digestOf(workOrder),
  })
}

export function reviewRequestedEvent(
  state: TaskState,
  seq: number,
  ids: { ticketId: string; requestId: string },
  extras: Partial<Pick<FusionEvent, 'id' | 'revision' | 'createdAt' | 'causeId'>> = {},
): Extract<FusionEvent, { type: 'review/requested' }> {
  return {
    schemaVersion: 1,
    id: extras.id ?? `review-requested-${ids.requestId}`,
    taskId: state.taskId,
    seq,
    revision: extras.revision ?? state.revision,
    type: 'review/requested',
    createdAt: extras.createdAt ?? new Date().toISOString(),
    causeId: extras.causeId ?? ids.requestId,
    payload: { ticket: createReviewTicket(state, ids) },
  }
}

export function reviewOutboxRow(ticket: Readonly<ReviewTicket>, payloadRef: string): OutboxRow {
  requireThat(payloadRef.length > 0, 'REVIEW_PAYLOAD_REF_REQUIRED')
  return {
    operationId: OperationId(`review:${ticket.requestId}`),
    taskId: ticket.subject.taskId,
    kind: 'review-request',
    state: 'prepared',
    payloadRef,
    requestId: ticket.requestId,
    ticket: structuredClone(ticket),
  }
}

/** Callback constructor. No TaskState argument: the producer cannot rebind to the latest task. */
export function resultFromCapturedTicket(
  ticket: Readonly<ReviewTicket>,
  outcome: {
    requestId: string
    terminalEvidenceRef: string
    classification: ReviewClassification
  },
  envelope: { eventId: string; seq: number; createdAt: string },
): Extract<FusionEvent, { type: 'review/completed' }> {
  requireThat(outcome.requestId === ticket.requestId, 'REVIEW_REQUEST_MISMATCH')
  requireThat(outcome.terminalEvidenceRef.length > 0, 'TERMINAL_EVIDENCE_REQUIRED')
  requireThat(envelope.eventId && Number.isSafeInteger(envelope.seq) && envelope.seq > 0, 'INVALID_EVENT_ENVELOPE')
  const classification = outcome.classification
  requireThat(classification.decision !== 'not_required', 'DIRECT_IS_NOT_A_REVIEW_RESULT')
  const protocolValid = classification.reviewStatus === 'complete'
    && classification.protocolComplete
    && classification.termination === 'success'
  const decision = protocolValid ? toReducerReviewDecision(classification) : 'REVIEW_INCOMPLETE'
  const binding: ReviewResultV2 = {
    ticketId: ticket.id,
    requestId: ticket.requestId,
    generation: ticket.generation,
    subject: structuredClone(ticket.subject),
    terminalEvidenceRef: outcome.terminalEvidenceRef,
    decision,
    protocolValid,
  }
  return {
    schemaVersion: 1,
    id: envelope.eventId,
    taskId: ticket.subject.taskId,
    seq: envelope.seq,
    revision: ticket.subject.revision,
    type: 'review/completed',
    createdAt: envelope.createdAt,
    causeId: ticket.requestId,
    payload: { decision, binding },
  }
}

/** Call at review dispatch AND immediately before committing verified completion. */
export function assertCurrentSubject(state: TaskState, ticket: ReviewTicket, actualSnapshot: ReportSubject['snapshot']): void {
  const workOrder = state.currentWorkOrder
  requireThat(workOrder, 'CURRENT_WORK_ORDER_REQUIRED')
  requireThat(workOrder.taskId === state.taskId && workOrder.id === ticket.subject.workOrderId, 'WORK_ORDER_CHANGED')
  requireThat(state.revision === workOrder.revision && workOrder.revision === ticket.subject.revision, 'REVISION_CHANGED')
  requireThat(digestOf(workOrder) === ticket.workOrderDigest, 'WORK_ORDER_CHANGED')
  requireThat(state.candidateReport && state.validatedReport && state.validatedReceipt, 'VALIDATED_CANDIDATE_REQUIRED')
  requireThat(digestOf(reportSubject(state.taskId, state.candidateReport)) === digestOf(ticket.subject), 'CANDIDATE_CHANGED')
  requireThat(digestOf(reportSubject(state.taskId, state.validatedReport)) === digestOf(ticket.subject), 'VALIDATED_REPORT_CHANGED')
  requireThat(digestOf(state.validatedReceipt.subject) === digestOf(ticket.subject), 'READINESS_SUBJECT_CHANGED')
  requireThat(digestOf(state.validatedReceipt) === ticket.validationDigest, 'READINESS_CHANGED')
  requireThat(actualSnapshot === ticket.subject.snapshot, 'WORKSPACE_CHANGED')
}
