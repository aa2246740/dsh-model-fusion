import type {
  AcceptanceCriterion,
  Digest,
  SnapshotId,
  TaskId,
  ToolEvidence,
  VerificationLevel,
  WorkOrder,
  WorkerReport,
} from '../contracts.js'
import { sha256Hex } from '../digest.js'
import {
  artifactFingerprint,
  assertPlannedCheck,
  checkPlanDigest,
  invocationHeader,
  sameInvocationHeader,
  type VerificationRegistry,
} from './receipts.js'

export interface EvidenceVerdict {
  readonly verification: VerificationLevel
  readonly reasons: readonly string[]
}

export type TrustedEvidenceRegistry =
  | readonly ToolEvidence[]
  | Readonly<Record<string, ToolEvidence>>
  | ReadonlyMap<string, ToolEvidence>

export interface RegisteredVerifier {
  readonly id: string
  readonly kind: AcceptanceCriterion['verificationKind']
  readonly argvDigests?: readonly Digest[]
}

export interface EvaluateReportOptions {
  readonly verifiers?: readonly RegisteredVerifier[]
  readonly registry?: VerificationRegistry
}

export const DEFAULT_TEST_VERIFIERS: readonly RegisteredVerifier[] = [
  { id: 'pytest', kind: 'test', argvDigests: [sha256Hex('python -m pytest')] },
  { id: 'npm-test', kind: 'test', argvDigests: [sha256Hex('npm test')] },
]

interface EvidenceIndex {
  readonly byId: ReadonlyMap<string, ToolEvidence>
  readonly ambiguous: ReadonlySet<string>
}

function sameIdentity(left: ToolEvidence, right: ToolEvidence): boolean {
  return left.operationId === right.operationId
    && left.taskId === right.taskId
    && left.nativeToolCallId === right.nativeToolCallId
}

function sameContent(left: ToolEvidence, right: ToolEvidence): boolean {
  return sameIdentity(left, right)
    && sameInvocationHeader(invocationHeader(left), invocationHeader(right))
    && left.argvDigest === right.argvDigest
    && left.cwdDigest === right.cwdDigest
    && left.actor === right.actor
    && left.state === right.state
    && left.exitCode === right.exitCode
    && left.inputSnapshot === right.inputSnapshot
    && left.outputSnapshot === right.outputSnapshot
    && left.endedAt === right.endedAt
    && left.startedAt === right.startedAt
    && artifactFingerprint(left.stdout) === artifactFingerprint(right.stdout)
    && artifactFingerprint(left.stderr) === artifactFingerprint(right.stderr)
    && (left.kind ?? 'tool') === (right.kind ?? 'tool')
}

function isLifecycleUpgrade(existing: ToolEvidence, incoming: ToolEvidence): boolean {
  return sameIdentity(existing, incoming)
    && sameInvocationHeader(invocationHeader(existing), invocationHeader(incoming))
    && existing.state === 'started'
    && incoming.state === 'completed'
}

function addAlias(byId: Map<string, ToolEvidence>, ambiguous: Set<string>, id: string, item: ToolEvidence): void {
  const existing = byId.get(id)
  if (!existing) {
    byId.set(id, item)
    return
  }
  if (sameContent(existing, item)) return
  if (isLifecycleUpgrade(existing, item)) {
    byId.set(id, item)
    return
  }
  if (isLifecycleUpgrade(item, existing)) return
  ambiguous.add(id)
}

function indexRegistry(registry: TrustedEvidenceRegistry): EvidenceIndex {
  const byId = new Map<string, ToolEvidence>()
  const ambiguous = new Set<string>()

  const add = (item: ToolEvidence, explicitId?: string) => {
    if (explicitId) addAlias(byId, ambiguous, explicitId, item)
    addAlias(byId, ambiguous, item.operationId, item)
    addAlias(byId, ambiguous, item.stdout.id, item)
    addAlias(byId, ambiguous, item.stderr.id, item)
  }

  if (registry instanceof Map) {
    for (const [id, item] of registry) add(item, id)
  } else if (Array.isArray(registry)) {
    for (const item of registry) add(item)
  } else {
    for (const [id, item] of Object.entries(registry)) add(item, id)
  }

  return { byId, ambiguous }
}

function eligibilityFailure(item: ToolEvidence, taskId: TaskId, currentSnapshot: SnapshotId): string | undefined {
  if (item.taskId !== taskId) return `evidence ${item.operationId} belongs to task ${item.taskId}, not ${taskId}`
  if (item.state !== 'completed') return `evidence ${item.operationId} is ${item.state}, not completed`
  if (item.endedAt === null) return `evidence ${item.operationId} has no endedAt`
  if (item.exitCode !== 0) return `evidence ${item.operationId} exited ${item.exitCode}`
  if (item.inputSnapshot !== currentSnapshot) {
    return `evidence ${item.operationId} input snapshot ${item.inputSnapshot} is not current ${currentSnapshot}`
  }
  if (item.outputSnapshot !== currentSnapshot) {
    return `evidence ${item.operationId} output snapshot ${item.outputSnapshot ?? 'missing'} is not current ${currentSnapshot}`
  }
  return undefined
}

function plannedCheckFailure(
  workOrder: WorkOrder,
  criterion: AcceptanceCriterion,
  evidenceId: string,
  registry: VerificationRegistry | undefined,
  actualSnapshot: SnapshotId,
): string | undefined {
  if (criterion.verificationKind === 'human' || criterion.verificationKind === 'review') return undefined
  if (!registry || !criterion.planId || !criterion.planDigest) {
    return `criterion ${criterion.id} has no frozen CheckPlan; allowedPaths are not a verification cwd`
  }
  const plan = registry.getPlan(criterion.planId)
  if (!plan) return `criterion ${criterion.id} cites unknown plan ${criterion.planId}`
  if (criterion.planDigest !== checkPlanDigest(plan)) {
    return `criterion ${criterion.id} plan digest does not match the frozen work-order plan`
  }
  const receipt = registry.getReceipt(evidenceId)
  if (!receipt) {
    return `criterion ${criterion.id} cites legacy evidence ${evidenceId} without a planned receipt`
  }
  try {
    assertPlannedCheck(workOrder, criterion.id, plan, receipt, actualSnapshot)
    return undefined
  } catch (error) {
    return `criterion ${criterion.id}: ${(error as Error).message}`
  }
}

function relevanceFailure(
  criterion: AcceptanceCriterion,
  record: ToolEvidence,
  verifiers: readonly RegisteredVerifier[],
): string | undefined {
  const kind = record.kind ?? 'tool'
  if (criterion.verificationKind === 'human') {
    if (kind !== 'human-decision') {
      return `human criterion ${criterion.id} cannot be fulfilled by a tool exit`
    }
    return undefined
  }
  if (criterion.verificationKind === 'review') {
    if (kind !== 'review-accept') {
      return `review criterion ${criterion.id} needs an accepting review record`
    }
    return undefined
  }
  const allowed = verifiers.filter(verifier => {
    if (verifier.kind !== criterion.verificationKind) return false
    if (criterion.verifierId && verifier.id !== criterion.verifierId) return false
    return true
  })
  if (!allowed.some(verifier => verifier.argvDigests?.includes(record.argvDigest))) {
    return `criterion ${criterion.id} evidence argv is not a registered ${criterion.verificationKind} verifier`
  }
  return undefined
}

/**
 * Score only the current work order's mandatory criteria and the evidence those
 * claims actually cite. Historical failures stay in the registry for audit.
 * Authenticity and relevance are independent checks.
 */
export function evaluateReport(
  workOrder: WorkOrder,
  report: WorkerReport,
  trustedRegistry: TrustedEvidenceRegistry,
  currentSnapshot: SnapshotId,
  options?: EvaluateReportOptions,
): EvidenceVerdict {
  const trust: string[] = []
  if (report.workOrderId !== workOrder.id) {
    trust.push(`report workOrderId ${report.workOrderId} does not match frozen work order ${workOrder.id}`)
  }
  if (report.revision !== workOrder.revision) {
    trust.push(`report revision ${report.revision} does not match frozen work order revision ${workOrder.revision}`)
  }
  if (report.snapshot !== currentSnapshot) {
    trust.push('snapshot drift: report snapshot is not the current workspace snapshot')
  }

  const acceptanceById = new Map(workOrder.acceptance.map(criterion => [criterion.id, criterion]))
  const seenClaims = new Set<string>()
  const index = indexRegistry(trustedRegistry)
  const verifiers = options?.verifiers ?? DEFAULT_TEST_VERIFIERS
  const satisfied = new Set<string>()

  for (const claim of report.coverage) {
    if (seenClaims.has(claim.criterionId)) {
      trust.push(`duplicate criterion ${claim.criterionId}`)
      continue
    }
    seenClaims.add(claim.criterionId)
    if (!acceptanceById.has(claim.criterionId)) {
      trust.push(`unknown criterion ${claim.criterionId}`)
      continue
    }
    if (claim.state !== 'satisfied') continue
    if (claim.evidenceIds.length === 0) {
      trust.push(`criterion ${claim.criterionId} claimed satisfied without evidence`)
      continue
    }
    const criterion = acceptanceById.get(claim.criterionId)!
    const cited = new Set<string>()
    let claimOk = true
    for (const evidenceId of claim.evidenceIds) {
      if (cited.has(evidenceId)) continue
      cited.add(evidenceId)
      if (index.ambiguous.has(evidenceId)) {
        trust.push(`criterion ${claim.criterionId} cites ambiguous evidence id ${evidenceId}`)
        claimOk = false
        continue
      }
      if (criterion.verificationKind === 'test' || criterion.verificationKind === 'static-check') {
        const planned = plannedCheckFailure(workOrder, criterion, evidenceId, options?.registry, currentSnapshot)
        if (planned) {
          trust.push(planned.startsWith('criterion ') ? planned : `criterion ${claim.criterionId}: ${planned}`)
          claimOk = false
        }
        continue
      }
      const record = index.byId.get(evidenceId)
      if (!record) {
        trust.push(`criterion ${claim.criterionId} cites unknown evidence id ${evidenceId}`)
        claimOk = false
        continue
      }
      const why = eligibilityFailure(record, workOrder.taskId, currentSnapshot)
        ?? relevanceFailure(criterion, record, verifiers)
      if (why) {
        trust.push(`criterion ${claim.criterionId}: ${why}`)
        claimOk = false
      }
    }
    if (claimOk) satisfied.add(claim.criterionId)
  }

  if (trust.length) {
    return { verification: 'unverified', reasons: trust }
  }

  const coverage: string[] = []
  if (report.status !== 'completed') {
    coverage.push(`report status is ${report.status}`)
  }
  if (report.unresolved.length) {
    coverage.push(`${report.unresolved.length} unresolved item(s) remain`)
  }
  for (const criterion of workOrder.acceptance) {
    if (!criterion.mandatory) continue
    if (!satisfied.has(criterion.id)) {
      coverage.push(`mandatory criterion ${criterion.id} is not satisfied by current trusted evidence`)
    }
  }
  if (coverage.length) {
    return { verification: 'partial', reasons: coverage }
  }
  return { verification: 'verified', reasons: [] }
}
