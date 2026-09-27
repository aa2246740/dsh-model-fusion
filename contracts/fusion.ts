/**
 * Proposed plugin-domain contracts, NOT existing DSH API declarations.
 * No runtime behavior or authorization is supplied by these types.
 * Convert DSH branded IDs only in the version-pinned bridge layer.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type TaskId = Brand<string, 'FusionTaskId'>;
export type SessionId = Brand<string, 'DshSessionId'>;
export type WorkOrderId = Brand<string, 'FusionWorkOrderId'>;
export type OperationId = Brand<string, 'FusionOperationId'>;
export type ArtifactId = Brand<string, 'FusionArtifactId'>;
export type SnapshotId = Brand<string, 'FusionSnapshotId'>;
export type Digest = Brand<string, 'Sha256Hex'>;
/** Decimal string avoids binary-float money and is JSON serializable. */
export type UsdDecimal = Brand<string, 'UsdDecimal'>;
export type EpochId = Brand<string, 'ContextEpochId'>;

export interface PhysicalRoute {
  provider: string;
  model: string;
  reasoningEffort?: string; // Validate against the owning adapter's opaque IDs.
}
export type RunSelection =
  | { kind: 'model'; route: PhysicalRoute }
  | { kind: 'profile'; profileId: string; requestedVersion?: string };
export type Role = 'lead' | 'worker';
export type Phase =
  | 'READY' | 'PLANNING' | 'DIRECT' | 'WORKER_RUNNING' | 'REVIEWING'
  | 'REWORK' | 'WAITING_APPROVAL' | 'WAITING_USER' | 'WAITING_BUDGET'
  | 'RECOVERING' | 'PAUSED' | 'STOPPING' | 'NEEDS_DECISION'
  | 'FAILED' | 'COMPLETED' | 'CANCELLED';
export type VerificationLevel = 'unverified' | 'partial' | 'verified';

export interface SourceRef {
  sessionId: SessionId;
  eventSeq: number;
  messageId?: string;
}
export interface ArtifactRef {
  id: ArtifactId;
  digest: Digest;
  ownerTaskId: TaskId;
  mediaType: string;
  bytes: number;
}
export interface Constraint {
  id: string;
  text: string;
  source: SourceRef;
  provenance: 'user' | 'policy' | 'inferred';
  mandatory: boolean;
}
export interface AcceptanceCriterion {
  id: string;
  description: string;
  verificationKind: 'test' | 'static-check' | 'human' | 'review';
  mandatory: boolean;
  verifierId?: string;
  planId?: string;
  planDigest?: Digest;
}
export interface ResourcePolicy {
  maxWorkerSteps: number;
  maxReworkRounds: number;
  maxCapabilityUpgrades: number;
  modelSpendAuthorizationId?: string;
  maxApiCostUsd?: UsdDecimal;
  maxTotalOutputTokens: number;
  /** Human approval has no expiry; only machine execution has a deadline. */
  commandMaxSeconds: number;
}
export interface WorkOrder {
  schemaVersion: 1;
  taskId: TaskId;
  id: WorkOrderId;
  operationId: OperationId;
  revision: number;
  goal: string;
  constraints: readonly Constraint[];
  acceptance: readonly AcceptanceCriterion[];
  allowedPaths: readonly string[];
  forbiddenActions: readonly string[];
  baseSnapshot: SnapshotId;
  evidence: readonly ArtifactRef[];
  decisions: readonly { text: string; source: SourceRef }[];
  uncertainties: readonly string[];
  policy: ResourcePolicy;
}
export interface CoverageClaim {
  criterionId: string;
  state: 'satisfied' | 'not-satisfied' | 'not-verified';
  evidenceIds: readonly ArtifactId[];
  explanation: string;
}
export interface WorkerReport {
  schemaVersion: 1;
  workOrderId: WorkOrderId;
  revision: number;
  status: 'completed' | 'blocked' | 'needs-decision';
  summary: string;
  snapshot: SnapshotId;
  changeManifest: ArtifactRef;
  coverage: readonly CoverageClaim[];
  verification: readonly ArtifactRef[];
  unresolved: readonly string[];
  questions: readonly string[];
}
export interface ToolEvidence {
  schemaVersion: 1;
  taskId: TaskId;
  operationId: OperationId;
  actor: SessionId;
  nativeToolCallId: string;
  argvDigest: Digest;
  cwdDigest: Digest;
  inputSnapshot: SnapshotId;
  outputSnapshot?: SnapshotId;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
  state: 'started' | 'completed' | 'cancelled' | 'outcome-unknown';
  kind?: 'tool' | 'human-decision' | 'review-accept';
}
export interface ContextCheckpoint {
  schemaVersion: 1;
  epochId: EpochId;
  taskId: TaskId;
  revision: number;
  goal: string;
  mandatoryConstraints: readonly Constraint[];
  snapshot: SnapshotId;
  decisions: readonly { text: string; source: SourceRef }[];
  coverage: readonly CoverageClaim[];
  pendingApprovalIds: readonly string[];
  openQuestions: readonly string[];
  evidence: readonly ArtifactRef[];
  sourceSurfaceSeqs: readonly number[]; // Surface order, NOT numeric sorting.
  digest: Digest;
}
export interface RoleContextPolicy {
  targetInputTokens: number;
  reserveOutputTokens: number;
  minSafetyTokens: number;
  safetyFraction: number;
  compactToFraction: number;
  evidenceReadTokens: number;
  maxToolVisibleTokens: number;
}
export interface PairProfile {
  schemaVersion: 1;
  id: string;
  version: string;
  digest: Digest;
  enabled: boolean;
  quality: 'experimental' | 'validated' | 'deprecated';
  lead: PhysicalRoute;
  worker: PhysicalRoute;
  workerUpgradePath: readonly PhysicalRoute[];
  promptDigests: Readonly<Record<'lead' | 'worker' | 'compact', Digest>>;
  context: Readonly<Record<Role, RoleContextPolicy>>;
  /** Experimental auxiliary calls, explicitly enabled for the frozen routes. */
  cacheKeepalive?: Readonly<Record<Role, boolean>>;
  /** Optional explicit summary route. Missing means the current role model. */
  compactor?: { readonly route: PhysicalRoute; readonly maxOutputTokens: number };
  dataPolicyId: string;
  evidenceCampaignIds: readonly string[];
}
export interface LogicalApproval {
  id: string;
  taskId: TaskId;
  revision: number;
  operationId: OperationId;
  nativeRequestId?: string;
  argsDigest: Digest;
  snapshot: SnapshotId;
  permissionPolicyDigest: Digest;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'consumed';
  decisionBy?: 'human' | 'preauthorized-policy';
  /** No expiresAt: pending human work does not expire automatically. */
}
export interface WriteLease {
  workspaceId: string;
  holder: SessionId;
  taskId: TaskId;
  generation: number;
  activeOperationIds: readonly OperationId[];
}
export interface TokenMeasurement {
  inputTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  safetyTokens: number;
  quality: 'exact' | 'provider-estimated' | 'heuristic';
  requestDigest: Digest;
}
/** Mutually exclusive buckets. Null means unavailable, never zero. */
export type UsageApplicability = 'not_applicable' | 'unknown' | 'known';
export interface NormalizedUsage {
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheReadStatus: UsageApplicability;
  cacheWrite: Readonly<Record<string, number | null>>;
  cacheWriteStatus: Readonly<Record<string, UsageApplicability>>;
  output: number | null;
  /** Informational subset; do not charge again if included in output. */
  reasoningOutputSubset: number | null;
  /** Separately billed reasoning. Charge at the reasoning or output rate. */
  reasoningSeparate: number | null;
  /** Reasoning tokens whose include-in-output contract is unknown. */
  reasoningUnspecified: number | null;
  reasoningBilling: {
    kind: 'included' | 'separate' | 'unknown' | 'not_applicable';
    tokens: number | null;
  };
  inputIncludesCacheRead: boolean | null;
}

export interface ReportSubject {
  taskId: TaskId;
  workOrderId: WorkOrderId;
  revision: number;
  reportId: string;
  reportDigest: Digest;
  snapshot: SnapshotId;
}
export interface ReviewTicket {
  id: string;
  requestId: string;
  generation: number;
  subject: ReportSubject;
  validationDigest: Digest;
  workOrderDigest: Digest;
}
export interface ControlState {
  mode: 'running' | 'paused' | 'stop-requested' | 'cancelled' | 'completed';
  pendingApprovalIds: readonly string[];
  budgetBlocked: boolean;
  recovering: boolean;
  outcomeUnknown: boolean;
}
export interface UsageAttempt {
  attemptId: string;
  taskId: TaskId;
  agentId: SessionId;
  role: Role;
  purpose: 'conversation' | 'compaction' | 'review' | 'routing' | 'other';
  route: PhysicalRoute;
  epochId: EpochId;
  serviceTier?: string;
  rawUsage?: ArtifactRef;
  normalized: NormalizedUsage;
  priceCardDigest?: Digest;
  apiEquivalentUsd: UsdDecimal | null;
  actualBilledUsd: UsdDecimal | null;
  status: 'pending' | 'complete' | 'partial' | 'unknown';
}
export interface EventEnvelope<T extends string, P> {
  schemaVersion: 1;
  id: string;
  taskId: TaskId;
  seq: number;
  revision: number;
  type: T;
  createdAt: string;
  causeId: string;
  payload: P;
}
export type FusionEvent =
  | EventEnvelope<'task/created', { parent: SessionId; selection: RunSelection }>
  | EventEnvelope<'work-order/prepared', { order: WorkOrder; reservedChild: SessionId }>
  | EventEnvelope<'child/accepted', { operationId: OperationId; child: SessionId; messageId: string }>
  | EventEnvelope<'report/validated', { operationId: OperationId; report: WorkerReport }>
  | EventEnvelope<'approval/pending', { approval: LogicalApproval }>
  | EventEnvelope<'effect/outcome-unknown', { operationId: OperationId; reason: string }>
  | EventEnvelope<'task/completed', { snapshot: SnapshotId; verification: VerificationLevel }>
  | EventEnvelope<'task/paused', { reason: string }>;
// Expand this union when implementing all specified event kinds; do not use any.
