/**
 * Plugin-domain contracts for dsh-model-fusion.
 * These are proposed types, not existing DSH API declarations.
 * Convert DSH branded IDs only in a version-pinned bridge (not landed).
 */
export type Brand<T, B extends string> = T & {
    readonly __brand: B;
};
export type TaskId = Brand<string, 'FusionTaskId'>;
export type SessionId = Brand<string, 'DshSessionId'>;
export type WorkOrderId = Brand<string, 'FusionWorkOrderId'>;
export type OperationId = Brand<string, 'FusionOperationId'>;
export type ArtifactId = Brand<string, 'FusionArtifactId'>;
export type SnapshotId = Brand<string, 'FusionSnapshotId'>;
export type Digest = Brand<string, 'Sha256Hex'>;
export type UsdDecimal = Brand<string, 'UsdDecimal'>;
export type EpochId = Brand<string, 'ContextEpochId'>;
export declare const TaskId: (raw: string) => TaskId;
export declare const SessionId: (raw: string) => SessionId;
export declare const WorkOrderId: (raw: string) => WorkOrderId;
export declare const OperationId: (raw: string) => OperationId;
export declare const ArtifactId: (raw: string) => ArtifactId;
export declare const SnapshotId: (raw: string) => SnapshotId;
export declare const EpochId: (raw: string) => EpochId;
export declare const UsdDecimal: (raw: string) => UsdDecimal;
export interface PhysicalRoute {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export type RunSelection = {
    kind: 'model';
    route: PhysicalRoute;
} | {
    kind: 'profile';
    profileId: string;
    requestedVersion?: string;
};
export type Role = 'lead' | 'worker';
export type Phase = 'READY' | 'PLANNING' | 'DIRECT' | 'WORKER_RUNNING' | 'REVIEWING' | 'REWORK' | 'WAITING_APPROVAL' | 'WAITING_USER' | 'WAITING_BUDGET' | 'RECOVERING' | 'PAUSED' | 'STOPPING' | 'NEEDS_DECISION' | 'FAILED' | 'COMPLETED' | 'CANCELLED';
export type VerificationLevel = 'unverified' | 'partial' | 'verified';
export type ExecutionIntent = 'DIRECT' | 'DELEGATE';
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
    /** Frozen verifier id. When set, only that registered verifier may satisfy the criterion. */
    verifierId?: string;
    /** Frozen CheckPlan id. Test/static criteria require a registered plan. */
    planId?: string;
    planDigest?: Digest;
}
export interface ResourcePolicy {
    maxWorkerSteps: number;
    maxReworkRounds: number;
    maxCapabilityUpgrades: number;
    modelSpendAuthorizationId?: string;
    maxApiCostUsd?: UsdDecimal;
    /** Legacy serialized planning field, not enforced by the native coordinator.
     * Native runs use the separately approved request/reservation ledger and omit
     * this field; old work orders retain it as historical data, not a hard cap. */
    maxTotalOutputTokens?: number;
    commandMaxSeconds: number;
}
export interface WorkOrder {
    schemaVersion: 1;
    /** Older work orders are implementation work. Exploration never grants a writer. */
    mode?: 'explore' | 'implement' | 'text';
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
    decisions: readonly {
        text: string;
        source: SourceRef;
    }[];
    uncertainties: readonly string[];
    policy: ResourcePolicy;
}
export interface ExplorationSource {
    path: string;
    startLine: number;
    endLine: number;
}
/** File excerpts are captured by the Host, not accepted from model narration. */
export interface ExplorationReport {
    schemaVersion: 1;
    workOrderId: WorkOrderId;
    revision: number;
    status: WorkerReport['status'];
    summary: string;
    unresolved: readonly string[];
    snapshot: SnapshotId;
    sources: readonly (ExplorationSource & {
        fileDigest: string;
        excerpt: ArtifactRef;
    })[];
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
export type EvidenceKind = 'tool' | 'human-decision' | 'review-accept';
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
    /** Default `tool`. Human/review criteria require their own kinds. */
    kind?: EvidenceKind;
}
export interface ContextCheckpoint {
    schemaVersion: 1;
    epochId: EpochId;
    taskId: TaskId;
    revision: number;
    goal: string;
    mandatoryConstraints: readonly Constraint[];
    snapshot: SnapshotId;
    decisions: readonly {
        text: string;
        source: SourceRef;
    }[];
    coverage: readonly CoverageClaim[];
    pendingApprovalIds: readonly string[];
    openQuestions: readonly string[];
    evidence: readonly ArtifactRef[];
    sourceSurfaceSeqs: readonly number[];
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
    /** Missing on frozen v1 sessions; only new selections use native model behavior. */
    interactionMode?: 'model-like';
    /** Frozen per selection. Absence preserves pre-enforcement sessions. */
    workflowPolicy?: 'enforced-v1' | 'enforced-v2' | 'enforced-v3';
    lead: PhysicalRoute;
    worker: PhysicalRoute;
    workerUpgradePath: readonly PhysicalRoute[];
    promptDigests: Readonly<Record<'lead' | 'worker' | 'compact', Digest>>;
    context: Readonly<Record<Role, RoleContextPolicy>>;
    /** Explicit per-route opt-in; absence preserves old frozen profile digests. */
    /** Per role: on, off, or 'auto' (armed once the route reports cache reads). Unset: Lead auto, Worker off. */
    cacheKeepalive?: Readonly<Record<Role, boolean | 'auto'>>;
    /** Optional explicit summary route; absence preserves the role model and old digests. */
    compactor?: {
        readonly route: PhysicalRoute;
        readonly maxOutputTokens: number;
    };
    dataPolicyId: string;
    evidenceCampaignIds: readonly string[];
}
export interface LogicalApproval {
    id: string;
    taskId: TaskId;
    revision: number;
    operationId: OperationId;
    nativeRequestId?: string;
    requestingAgent?: SessionId;
    toolName?: string;
    callId?: string;
    role?: Role;
    reason?: string;
    argsDigest: Digest;
    snapshot: SnapshotId;
    permissionPolicyDigest: Digest;
    state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'consumed';
    decisionBy?: 'human' | 'preauthorized-policy';
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
export type UsageApplicability = 'not_applicable' | 'unknown' | 'known';
export interface NormalizedUsage {
    uncachedInput: number | null;
    cacheRead: number | null;
    cacheReadStatus: UsageApplicability;
    cacheWrite: Readonly<Record<string, number | null>>;
    cacheWriteStatus: Readonly<Record<string, UsageApplicability>>;
    output: number | null;
    /** Informational subset already inside `output`. Do not charge again. */
    reasoningOutputSubset: number | null;
    /** Separately billed reasoning. Charge at the reasoning or output rate. */
    reasoningSeparate: number | null;
    /** Reasoning tokens whose include-in-output contract is unknown. Never assume free or included. */
    reasoningUnspecified: number | null;
    /** Explicit billing relation. Never infer not_applicable from a null quantity. */
    reasoningBilling: ReasoningBilling;
    /** Null when the provider contract was not stated. */
    inputIncludesCacheRead: boolean | null;
}
export interface ReasoningBilling {
    kind: 'included' | 'separate' | 'unknown' | 'not_applicable';
    tokens: number | null;
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
export interface ReviewGate {
    taskId: TaskId;
    workOrderId: WorkOrderId;
    revision: number;
    reportDigest: Digest;
    snapshot: SnapshotId;
    reviewAttemptId: string;
    decision: 'accept' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE';
    terminalStatus: 'accepting' | 'incomplete' | 'rework' | 'needs-decision' | 'legacy-unbound';
}
export interface ReportSubject {
    taskId: TaskId;
    workOrderId: WorkOrderId;
    revision: number;
    reportId: string;
    reportDigest: Digest;
    snapshot: SnapshotId;
}
export interface ReviewReadinessReceipt {
    subject: ReportSubject;
    receiptId: string;
    receiptDigest: Digest;
    verdict: 'review-ready';
}
export interface ReviewTicket {
    id: string;
    requestId: string;
    generation: number;
    subject: ReportSubject;
    validationDigest: Digest;
    /** Digest of the work order frozen at request time. */
    workOrderDigest: Digest;
}
export interface ReviewResultV2 {
    ticketId: string;
    requestId: string;
    generation: number;
    subject: ReportSubject;
    terminalEvidenceRef: string;
    decision: 'accept' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE';
    protocolValid: boolean;
}
export interface ControlState {
    mode: 'running' | 'paused' | 'stop-requested' | 'cancelled' | 'completed';
    pendingApprovalIds: readonly string[];
    budgetBlocked: boolean;
    recovering: boolean;
    outcomeUnknown: boolean;
}
export interface ReviewCompletedPayload {
    decision: 'accept' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE';
    /** Required for a new completion. Decision-only payloads are legacy-unbound. */
    binding?: ReviewResultV2;
}
export type FusionEvent = EventEnvelope<'task/created', {
    parent: SessionId;
    selection: RunSelection;
}> | EventEnvelope<'requirements/revised', {
    reason: string;
}> | EventEnvelope<'profile/frozen', {
    digest: Digest;
    profileId: string;
    version: string;
}> | EventEnvelope<'intent/chosen', {
    intent: ExecutionIntent;
}> | EventEnvelope<'work-order/prepared', {
    order: WorkOrder;
    reservedChild: SessionId;
}> | EventEnvelope<'work-order/acceptance-amended', {
    workOrderId: WorkOrderId;
    acceptance: readonly AcceptanceCriterion[];
    reason: string;
}> | EventEnvelope<'child/accepted', {
    operationId: OperationId;
    child: SessionId;
    messageId: string;
}> | EventEnvelope<'child/claimed', {
    operationId: OperationId;
    child: SessionId;
}> | EventEnvelope<'exploration/recorded', {
    report: ExplorationReport;
}> | EventEnvelope<'report/submitted', {
    operationId: OperationId;
    report: WorkerReport;
}> | EventEnvelope<'report/validated', {
    operationId: OperationId;
    report: WorkerReport;
}> | EventEnvelope<'review/requested', {
    ticket: ReviewTicket;
}> | EventEnvelope<'review/completed', ReviewCompletedPayload> | EventEnvelope<'lease/acquired', {
    lease: WriteLease;
}> | EventEnvelope<'lease/released', {
    workspaceId: string;
    generation: number;
}> | EventEnvelope<'approval/pending', {
    approval: LogicalApproval;
}> | EventEnvelope<'approval/answered', {
    approvalId: string;
    state: 'approved' | 'rejected' | 'withdrawn';
}> | EventEnvelope<'budget/blocked', {
    reason: string;
}> | EventEnvelope<'budget/unblocked', {
    authorizationId: string;
}> | EventEnvelope<'checkpoint/committed', {
    checkpoint: ContextCheckpoint;
}> | EventEnvelope<'recovery/needed', {
    reason: string;
}> | EventEnvelope<'recovery/reconciled', {
    snapshot: SnapshotId;
    evidenceRef: string;
}> | EventEnvelope<'effect/outcome-unknown', {
    operationId: OperationId;
    reason: string;
}> | EventEnvelope<'effects/reconciled', {
    snapshot: SnapshotId;
    evidenceRef: string;
    quiescent: true;
}> | EventEnvelope<'task/stop-requested', {
    intent: 'pause' | 'cancel';
}> | EventEnvelope<'task/paused', {
    reason: string;
}> | EventEnvelope<'task/resumed', {
    reason: string;
}> | EventEnvelope<'task/completed', {
    snapshot: SnapshotId;
    verification: VerificationLevel;
}> | EventEnvelope<'task/cancelled', {
    reason: string;
}>;
export type OutboxState = 'prepared' | 'dispatched' | 'accepted' | 'claimed' | 'result-recorded' | 'delivered' | 'acknowledged';
export interface OutboxRow {
    operationId: OperationId;
    taskId: TaskId;
    kind: string;
    state: OutboxState;
    reservedChild?: SessionId;
    nativeMessageId?: string;
    resultDigest?: Digest;
    payloadRef?: string;
    requestId?: string;
    ticket?: ReviewTicket;
}
export declare const TERMINAL_PHASES: Set<Phase>;
