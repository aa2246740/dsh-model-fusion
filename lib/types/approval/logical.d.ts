import type { Digest, LogicalApproval, SnapshotId } from '../contracts.js';
export interface ApprovalScope {
    argsDigest: Digest;
    snapshot: SnapshotId;
    permissionPolicyDigest: Digest;
}
export declare function answerApproval(approval: LogicalApproval, state: 'approved' | 'rejected' | 'withdrawn', decisionBy?: 'human' | 'preauthorized-policy'): LogicalApproval;
export declare function consumeApproval(approval: LogicalApproval, scope: ApprovalScope): LogicalApproval;
export declare function neverMeansDeny(policy: string): boolean;
export declare function pendingDoesNotExpire(_approval: LogicalApproval, _nowMs: number): true;
