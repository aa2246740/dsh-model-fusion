import type { PairProfile, TaskId } from '../contracts.js';
import type { PromptBundle, ResolvedProfile } from '../profile/resolve.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
export interface SessionBinding {
    readonly schemaVersion: 1;
    readonly sessionId: string;
    readonly taskId: TaskId;
    readonly selected: boolean;
    /** One native continuable Worker for this selection, across completed tasks. */
    readonly workerId?: string;
    readonly profile: PairProfile;
    readonly prompts: PromptBundle;
}
export declare function readBinding(value: unknown, sessionId: string): SessionBinding;
/** Selection is durable and scoped by the native Lead identity, never a global default. */
export declare class BindingRepository {
    private readonly store;
    constructor(store: SqliteFusionStore);
    read(sessionId: string): {
        revision: number;
        binding: SessionBinding;
    } | undefined;
    select(sessionId: string, id: TaskId, resolved: ResolvedProfile): SessionBinding;
    clear(sessionId: string): void;
    /** Reserve identity before native dispatch; an existing selection cannot swap workers. */
    assignWorker(sessionId: string, expectedTask: TaskId, workerId: string): void;
    /** A new native user turn starts a new task while preserving the frozen pair. */
    rollover(sessionId: string, expectedTask: TaskId, nextTask: TaskId): SessionBinding;
    selected(): readonly SessionBinding[];
}
