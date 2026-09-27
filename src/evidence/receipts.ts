import type { Digest, SnapshotId, TaskId, ToolEvidence, WorkOrder, WorkOrderId } from '../contracts.js'
import { digestOf } from '../digest.js'
import { EVENT_CONFLICT, FusionError } from '../errors.js'

export interface InvocationHeader {
  taskId: ToolEvidence['taskId']
  workOrderId?: WorkOrderId
  revision?: number
  operationId: ToolEvidence['operationId']
  actor: ToolEvidence['actor']
  nativeToolCallId: string
  argvDigest: Digest
  cwdDigest: Digest
  inputSnapshot: SnapshotId
  startedAt: string
  verifierPlanDigest?: Digest
}

export interface CheckPlan {
  id: string
  version: number
  taskId: TaskId
  workOrderId: WorkOrderId
  revision: number
  criterionId: string
  kind: 'test' | 'static-check' | 'human' | 'review'
  snapshot: SnapshotId
  /**
   * Version 2 may freeze the verifier before editing. `snapshot` then names the
   * WorkOrder base; native invocation receipts must still bind both input and
   * output to the exact current candidate. Omission retains v1 exact semantics.
   */
  snapshotBinding?: 'candidate'
  cwdDigest: Digest
  argvDigest: Digest
  definitionDigest: Digest
  policyDigest: Digest
  minExecutedTests?: number
  /**
   * Baseline-relative test check: ids that already failed on the untouched workspace, frozen before the
   * Worker started. Only these may fail on the candidate; every other executed test must pass.
   */
  allowedFailures?: readonly string[]
}

export interface PlannedReceipt {
  id: string
  planDigest: Digest
  evidence: ToolEvidence
  counts?: { executed: number; passed: number; failed: number
    /** Failures frozen in the plan's baseline (not counted as executed). */
    knownFailures?: readonly string[]
    /** Failures absent from the baseline; counted in `failed`. */
    newFailures?: readonly string[] }
}

export interface VerificationRegistry {
  getPlan(planId: string): CheckPlan | undefined
  getReceipt(receiptId: string): PlannedReceipt | undefined
}

export function memoryVerificationRegistry(
  plans: readonly CheckPlan[],
  receipts: readonly PlannedReceipt[],
): VerificationRegistry {
  const planById = new Map(plans.map(plan => [plan.id, freezePlan(plan)]))
  const receiptById = new Map(receipts.map(receipt => [receipt.id, structuredClone(receipt)]))
  return {
    getPlan: id => planById.get(id),
    getReceipt: id => {
      const receipt = receiptById.get(id)
      return receipt === undefined ? undefined : structuredClone(receipt)
    },
  }
}

function freezePlan(plan: CheckPlan): CheckPlan {
  return Object.freeze(structuredClone(plan))
}

function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new FusionError(EVENT_CONFLICT, code)
}

export function assertPlannedCheck(
  workOrder: WorkOrder,
  criterionId: string,
  plan: CheckPlan,
  receipt: PlannedReceipt,
  actualSnapshot: SnapshotId,
): void {
  requireThat(plan.taskId === workOrder.taskId && plan.workOrderId === workOrder.id && plan.revision === workOrder.revision, 'PLAN_SCOPE_MISMATCH')
  requireThat(plan.criterionId === criterionId, 'CRITERION_SCOPE_MISMATCH')
  requireThat(receipt.planDigest === digestOf(plan), 'PLAN_DIGEST_MISMATCH')
  if (plan.snapshotBinding === undefined) {
    requireThat(plan.snapshot === actualSnapshot, 'PLAN_SNAPSHOT_MISMATCH')
  } else {
    requireThat(plan.snapshotBinding === 'candidate' && plan.version === 2, 'UNSUPPORTED_SNAPSHOT_BINDING')
    requireThat(plan.snapshot === workOrder.baseSnapshot, 'PLAN_BASE_SNAPSHOT_MISMATCH')
  }
  const criterion = workOrder.acceptance.find(item => item.id === criterionId)
  requireThat(criterion && criterion.verificationKind === plan.kind, 'VERIFIER_KIND_MISMATCH')
  requireThat(criterion.planId === plan.id && criterion.planDigest === digestOf(plan), 'PLAN_NOT_FROZEN_IN_WORK_ORDER')
  requireThat(plan.kind === 'test' || plan.kind === 'static-check', 'USE_TYPED_HUMAN_OR_REVIEW_RECEIPT')
  requireThat(plan.cwdDigest && plan.argvDigest, 'EXACT_VERIFIER_CONTEXT_REQUIRED')
  const evidence = receipt.evidence
  requireThat(evidence.taskId === workOrder.taskId && evidence.cwdDigest === plan.cwdDigest && evidence.argvDigest === plan.argvDigest, 'INVOCATION_SCOPE_MISMATCH')
  // A baseline-relative run exits non-zero while frozen pre-existing failures remain; its counts must then
  // show that every failure was one of them.
  const knownOnly = plan.kind === 'test' && plan.allowedFailures !== undefined && receipt.counts?.failed === 0
    && (receipt.counts.knownFailures ?? []).every(id => plan.allowedFailures!.includes(id))
  requireThat(evidence.state === 'completed' && evidence.endedAt !== null
    && (evidence.exitCode === 0 || (knownOnly && evidence.exitCode !== null && (receipt.counts?.knownFailures?.length ?? 0) > 0)), 'CHECK_NOT_SUCCESSFUL')
  requireThat(evidence.inputSnapshot === actualSnapshot && evidence.outputSnapshot === actualSnapshot, 'CHECK_SNAPSHOT_MISMATCH')
  if (plan.kind === 'test') {
    const counts = receipt.counts
    requireThat(counts && [counts.executed, counts.passed, counts.failed].every(value => Number.isSafeInteger(value) && value >= 0), 'TEST_COUNTS_REQUIRED')
    requireThat(counts.executed >= (plan.minExecutedTests ?? 1) && counts.failed === 0 && counts.passed === counts.executed, 'TEST_SUITE_NOT_PASSED')
  }
}

export function invocationHeader(record: ToolEvidence, extras: Partial<InvocationHeader> = {}): InvocationHeader {
  return {
    taskId: record.taskId,
    operationId: record.operationId,
    actor: record.actor,
    nativeToolCallId: record.nativeToolCallId,
    argvDigest: record.argvDigest,
    cwdDigest: record.cwdDigest,
    inputSnapshot: record.inputSnapshot,
    startedAt: record.startedAt,
    ...extras,
  }
}

export function sameInvocationHeader(left: InvocationHeader, right: InvocationHeader): boolean {
  return digestOf(left) === digestOf(right)
}

export function artifactFingerprint(ref: ToolEvidence['stdout']): string {
  return digestOf({
    id: ref.id,
    digest: ref.digest,
    bytes: ref.bytes,
    ownerTaskId: ref.ownerTaskId,
    mediaType: ref.mediaType,
  })
}

export function resolveInvocation(records: readonly ToolEvidence[]): ToolEvidence {
  if (!records.length) throw new FusionError(EVENT_CONFLICT, 'NO_INVOCATION')
  const header = invocationHeader(records[0]!)
  for (const record of records) {
    if (!sameInvocationHeader(header, invocationHeader(record))) {
      throw new FusionError(EVENT_CONFLICT, 'IMMUTABLE_INVOCATION_CHANGED')
    }
  }
  const terminals = records.filter(record => record.state !== 'started')
  if (!terminals.length) return records[0]!
  const first = terminals[0]!
  for (const terminal of terminals) {
    if (digestOf({ ...first, id: undefined }) !== digestOf({ ...terminal, id: undefined })) {
      throw new FusionError(EVENT_CONFLICT, 'EVIDENCE_TERMINAL_CONFLICT')
    }
  }
  if (first.endedAt === null) throw new FusionError(EVENT_CONFLICT, 'TERMINAL_END_REQUIRED')
  if (first.state === 'completed' && (first.exitCode === null || !Number.isSafeInteger(first.exitCode))) {
    throw new FusionError(EVENT_CONFLICT, 'EXIT_STATUS_REQUIRED')
  }
  return first
}

export function checkPlanDigest(plan: CheckPlan): Digest {
  return digestOf(plan)
}
