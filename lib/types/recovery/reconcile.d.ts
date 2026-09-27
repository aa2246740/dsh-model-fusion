import type { OutboxRow, SessionId } from '../contracts.js';
import { NEEDS_REPAIR, OUTCOME_UNKNOWN } from '../errors.js';
export type ChildPersistence = 'present' | 'missing' | 'corrupt';
export interface RecoveryScan {
    readonly outbox: OutboxRow;
    readonly childPersistence: ChildPersistence;
    readonly effectKnown: boolean | null;
    readonly reportAlreadyRecorded: boolean;
    readonly parentDelivered: boolean;
}
export type RecoveryDecision = {
    action: 'retry-prepare';
    child: SessionId;
} | {
    action: 'resume-child';
    child: SessionId;
} | {
    action: 'return-stored-result';
} | {
    action: 'needs-repair';
    code: typeof NEEDS_REPAIR;
} | {
    action: 'outcome-unknown';
    code: typeof OUTCOME_UNKNOWN;
} | {
    action: 'idle';
};
export declare function reconcile(scan: RecoveryScan): RecoveryDecision;
