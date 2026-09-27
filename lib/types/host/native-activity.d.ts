import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { FusionActivityPage } from '../activity.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
/** Paginated read-only data for a plugin-owned tool view; no runtime activation. */
export declare function readFusionActivity(store: SqliteFusionStore, parentId: string, callId: string, after?: number): FusionActivityPage;
/** Old conversations remain readable through the public, non-activating history
 * API. Correlate accepted message ids, never timing guesses or model narration.
 * This fallback neither rewrites the old log nor creates a replacement Worker.
 */
export declare function readHistoricalFusionActivity(ctx: Context, store: SqliteFusionStore, parentId: string, callId: string, after?: number): Promise<FusionActivityPage>;
/** Copies actual Worker tool events into plugin-owned presentation storage only.
 * Model history still contains solely the Lead's native messages and reports.
 * Stored source coordinates make replay/HMR idempotent without executing tools.
 */
export declare class NativeFusionActivity {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly errors: Map<string, string>;
    constructor(ctx: Context, store: SqliteFusionStore);
    /** Called before each native delivery. No inference, dispatch or approval. */
    link(parent: Session, childId: string, taskId: string, callId: string): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
