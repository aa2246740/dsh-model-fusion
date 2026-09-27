import type { TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
/** Coverage uses logical receipt IDs; ordinary evidence uses content digests. */
export declare function readNativeEvidence(store: SqliteFusionStore, taskId: TaskId, id: string): Uint8Array;
