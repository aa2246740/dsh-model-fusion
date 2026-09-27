import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives';
import type { FusionActivity } from '../activity.js';
export interface ActivityRow {
    id: string;
    call: Extract<FusionActivity['source'], {
        type: 'tool/call';
    }>;
    result?: Extract<FusionActivity['source'], {
        type: 'tool/result';
    }>;
}
export declare function activityRows(events: readonly FusionActivity[]): ActivityRow[];
/** Only actual result-time metadata is labelled an applied diff. */
export declare function activityDiffs(row: ActivityRow): DiffHunk[];
