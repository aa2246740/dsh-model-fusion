import type { TaskState } from '../task/state.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { FusionStatus } from '../status.js';
export declare function taskStage(state: TaskState, checking: boolean, workerStepLimitReached?: boolean, workerQuotaExhausted?: boolean): Pick<NonNullable<FusionStatus['task']>, 'stage' | 'detail' | 'attention'>;
/** Reads existing durable facts only. Polling never constructs a runtime or calls a model. */
export declare function readFusionStatus(store: SqliteFusionStore, sessionId: string): FusionStatus;
