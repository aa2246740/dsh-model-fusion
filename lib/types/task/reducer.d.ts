import type { FusionEvent } from '../contracts.js';
import type { TaskState } from './state.js';
declare function assertControlAllowsExecution(state: TaskState): void;
export declare function reduce(state: TaskState | undefined, event: FusionEvent): TaskState;
export declare function reduceAll(events: readonly FusionEvent[]): TaskState;
export { assertControlAllowsExecution };
