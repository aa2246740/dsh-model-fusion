import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LogicalApproval, Role, TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { TaskState } from '../task/state.js';
import type { SessionBinding } from './bindings.js';
type Owner = {
    binding: SessionBinding;
    role: Role;
};
interface Callbacks {
    owner(agent: Agent): Owner | undefined;
    state(id: TaskId): TaskState;
    pending(id: TaskId, approval: LogicalApproval): void;
    answered(id: TaskId, approvalId: string, state: 'approved' | 'rejected' | 'withdrawn'): void;
    failed(agent: Agent, error: unknown): void;
}
/** Observe native decisions; never answer on the user's behalf or replay a grant. */
export declare class NativeApprovals {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly callbacks: Callbacks;
    constructor(ctx: Context, store: SqliteFusionStore, callbacks: Callbacks);
    install(): () => void;
    /** Caller must first stop/release both native Agents and inspect uncertain effects. */
    reconcile(taskId: TaskId, evidence: string): void;
}
export {};
