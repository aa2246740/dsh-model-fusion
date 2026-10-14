import type { FusionStatus } from '../status.js';
interface Snapshot {
    sessionId: string;
    status?: FusionStatus;
    failed: boolean;
}
/** One in-flight read per mounted session; collapsed hints still discover new attention states. */
export declare function useFusionStatus(sessionId: string, expandedTask: string | undefined, attentionOnly?: boolean): Snapshot | undefined;
export {};
