import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Role, TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
export declare const FUSION_TASK_CONTEXT = "fusion:task";
export type ContextDetail = 'compact' | 'full';
/** Programmatic facts travel as native user-role context, never as system instructions. */
export declare class NativeTaskContext {
    #private;
    readonly store: SqliteFusionStore;
    readonly parent: (id: string) => Agent | undefined;
    constructor(store: SqliteFusionStore, parent: (id: string) => Agent | undefined);
    begin(agent: Agent, taskId: TaskId): void;
    /**
     * `compact` is appended on every changed step: it carries only state the
     * native history does not already hold, so the expensive Lead does not
     * re-read its own brief, the delivered report or the user's messages on
     * every request. `full` restores everything after compaction, when those
     * native messages may have been summarized away.
     */
    render(binding: SessionBinding, role: Role, detail?: ContextDetail): string;
    /** Run after native pre-step handlers, including the existing compaction owner. */
    message(agent: Agent, binding: SessionBinding, role: Role, detail?: ContextDetail): UserMessage | undefined;
    /** The final frozen request must contain the snapshot that was actually assembled. */
    assertPresent(agent: Agent, binding: SessionBinding, role: Role, request: GenerateOptions): void;
    prepareCompaction(agent: Agent, binding: SessionBinding, role: Role, sourceSurfaceSeqs: readonly number[]): string;
    restoreCompaction(agent: Agent, binding: SessionBinding, role: Role, id: string, compactionId: string): void;
}
