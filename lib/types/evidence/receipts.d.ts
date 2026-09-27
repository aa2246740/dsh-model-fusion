import type { Digest, SnapshotId, TaskId, ToolEvidence, WorkOrder, WorkOrderId } from '../contracts.js';
export interface InvocationHeader {
    taskId: ToolEvidence['taskId'];
    workOrderId?: WorkOrderId;
    revision?: number;
    operationId: ToolEvidence['operationId'];
    actor: ToolEvidence['actor'];
    nativeToolCallId: string;
    argvDigest: Digest;
    cwdDigest: Digest;
    inputSnapshot: SnapshotId;
    startedAt: string;
    verifierPlanDigest?: Digest;
}
export interface CheckPlan {
    id: string;
    version: number;
    taskId: TaskId;
    workOrderId: WorkOrderId;
    revision: number;
    criterionId: string;
    kind: 'test' | 'static-check' | 'human' | 'review';
    snapshot: SnapshotId;
    /**
     * Version 2 may freeze the verifier before editing. `snapshot` then names the
     * WorkOrder base; native invocation receipts must still bind both input and
     * output to the exact current candidate. Omission retains v1 exact semantics.
     */
    snapshotBinding?: 'candidate';
    cwdDigest: Digest;
    argvDigest: Digest;
    definitionDigest: Digest;
    policyDigest: Digest;
    minExecutedTests?: number;
    /**
     * Baseline-relative test check: ids that already failed on the untouched workspace, frozen before the
     * Worker started. Only these may fail on the candidate; every other executed test must pass.
     */
    allowedFailures?: readonly string[];
}
export interface PlannedReceipt {
    id: string;
    planDigest: Digest;
    evidence: ToolEvidence;
    counts?: {
        executed: number;
        passed: number;
        failed: number;
        /** Failures frozen in the plan's baseline (not counted as executed). */
        knownFailures?: readonly string[];
        /** Failures absent from the baseline; counted in `failed`. */
        newFailures?: readonly string[];
    };
}
export interface VerificationRegistry {
    getPlan(planId: string): CheckPlan | undefined;
    getReceipt(receiptId: string): PlannedReceipt | undefined;
}
export declare function memoryVerificationRegistry(plans: readonly CheckPlan[], receipts: readonly PlannedReceipt[]): VerificationRegistry;
export declare function assertPlannedCheck(workOrder: WorkOrder, criterionId: string, plan: CheckPlan, receipt: PlannedReceipt, actualSnapshot: SnapshotId): void;
export declare function invocationHeader(record: ToolEvidence, extras?: Partial<InvocationHeader>): InvocationHeader;
export declare function sameInvocationHeader(left: InvocationHeader, right: InvocationHeader): boolean;
export declare function artifactFingerprint(ref: ToolEvidence['stdout']): string;
export declare function resolveInvocation(records: readonly ToolEvidence[]): ToolEvidence;
export declare function checkPlanDigest(plan: CheckPlan): Digest;
