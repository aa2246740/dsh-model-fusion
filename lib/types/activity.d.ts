import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
/** Plugin-owned presentation record; never appended to a native Session. */
export interface FusionActivity {
    schemaVersion: 1;
    taskId: string;
    childSessionId: string;
    parentCallId: string;
    turn: number;
    step: number;
    anchorSeq: number;
    source: SessionEvent<'tool/call'> | SessionEvent<'tool/result'>;
}
/** Namespaced display identity; the unchanged native identity remains in source. */
export declare function activityCallId(activity: FusionActivity): string;
export interface FusionActivityPage {
    events: FusionActivity[];
    cursor: number;
    more: boolean;
    done: boolean;
}
