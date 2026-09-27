import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmFailure, UserMessage } from '@deepseek-ai/dsh-llm';
import type { PhysicalRoute, Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import { type SessionBinding } from './bindings.js';
export interface ModelControl {
    schemaVersion: 1;
    sessionId: string;
    profileDigest: string;
    epoch: number;
    recoveryEpoch?: number;
    /** Lead-cleared recoverable Worker waits for the current task (bounded). */
    leadRecoveries?: {
        taskId: string;
        count: number;
    };
    routes: Record<Role, PhysicalRoute>;
    waits: Partial<Record<Role, {
        taskId: string;
        code: string;
        at: string;
        retryNotBefore?: string;
        quotaResetAt: null;
    }>>;
    operation?: {
        id: string;
        taskId: string;
        state: 'prepared' | 'dispatching' | 'delivered' | 'failed';
        message?: UserMessage;
        error?: string;
    };
    schedule?: {
        id: string;
        taskId: string;
        epoch: number;
        dueAt: string;
        userSeq: number;
        state: 'scheduled' | 'cancelled' | 'fired' | 'failed';
        reason?: string;
    };
}
export interface ControlView extends ModelControl {
    revision: number;
}
export declare function readModelControl(store: SqliteFusionStore, binding: SessionBinding): ControlView | undefined;
interface Callbacks {
    owner(agent: Agent): {
        binding: SessionBinding;
        role: Role;
    } | undefined;
    resolve(sessionId: string): Promise<Agent>;
    pause(agent: Agent): Promise<void>;
    resume(agent: Agent): Promise<void>;
    settled(binding: SessionBinding): boolean;
    stopAuxiliary(binding: SessionBinding): void;
}
/** Durable local controls. No provider polling, synthetic user identity, or silent routing fallback. */
export declare class NativeModelControl {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly callbacks: Callbacks;
    constructor(ctx: Context, store: SqliteFusionStore, callbacks: Callbacks);
    reset(binding: SessionBinding): void;
    write(view: ControlView): number;
    route(binding: SessionBinding, role: Role): PhysicalRoute;
    waiting(binding: SessionBinding, role: Role): {
        taskId: string;
        code: string;
        at: string;
        retryNotBefore?: string;
        quotaResetAt: null;
    } | undefined;
    /**
     * Clear a role wait the Lead can resolve itself by sending a new instruction: a missing report or
     * transition (WORKFLOW_INCOMPLETE), a repeated unchanged result (NO_PROGRESS) or an unclassified
     * error (UNKNOWN). At most LEAD_RECOVERIES per task; quota and credential stops are never cleared here.
     */
    leadRecover(binding: SessionBinding, role: Role): boolean;
    /** The role stalled again after the Lead already redirected it LEAD_RECOVERIES times this task. */
    recoveriesExhausted(binding: SessionBinding, role: Role): boolean;
    blocked(binding: SessionBinding, role: Role): string | undefined;
    reconcileDelivery(agent: Agent, binding: SessionBinding, evidenceId: string): void;
    failure(binding: SessionBinding, role: Role, failure: LlmFailure): void;
    private require;
    private userSeq;
    cancel(binding: SessionBinding, reason?: string): void;
    schedule(sessionId: string, taskId: string, revision: number, dueAt: string): Promise<void>;
    continue(sessionId: string, taskId: string, revision: number, change?: {
        role: Role;
        route: PhysicalRoute;
    }, scheduledId?: string): Promise<void>;
    private runContinue;
    private clearTimer;
    private arm;
    close(): Promise<void>;
}
export {};
