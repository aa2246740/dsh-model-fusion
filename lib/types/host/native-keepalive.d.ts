import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { Role, TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
import type { CacheMode } from './cache-defaults.js';
import { NativeAuxiliaryRequests } from './native-auxiliary.js';
/** R19 recovered schedule; one-token output is this plugin's conservative cap. */
export declare const KEEPALIVE_INTERVAL_MS = 285000;
export declare const KEEPALIVE_ATTEMPTS = 11;
export interface KeepaliveClock {
    now(): number;
    schedule(callback: () => void, delayMs: number): () => void;
}
type Owner = {
    binding: SessionBinding;
    role: Role;
};
interface Callbacks {
    owner(agent: Agent): Owner | undefined;
    allowed(agent: Agent, owner: Owner): boolean;
    failed(agent: Agent, reason: string): void;
    /** Per-model mode and interval (user setting, learned, defaults); absent: the pair profile and a fixed interval. */
    policy?(owner: Owner, provider: string, model: string): {
        mode: CacheMode;
        intervalMs: number;
    };
    /** Evidence for learning and the settings page: a request after a wait, or a ping. */
    observe?(owner: Owner, provider: string, model: string, sample: {
        gapSeconds: number;
        ping: boolean;
        hit: boolean;
        cacheRead: number;
        input: number;
    }): void;
}
export interface KeepaliveRecord {
    schemaVersion: 1;
    id: string;
    taskId: TaskId;
    sessionId: string;
    role: Role;
    profileDigest: string;
    inputDigest: string;
    createdAt: string;
    updatedAt: string;
    state: 'generating' | 'scheduled' | 'inflight' | 'stopped';
    attempts: number;
    successes: number;
    stopReason?: string;
}
/** Retains only plugin-owned requests in memory; never replays timers on restart. */
/** Explicit per-role choice; unset is automatic for the Lead (armed only on observed cache reads), off for the Worker. */
export declare function keepalivePolicy(binding: SessionBinding, role: Role): boolean | 'auto';
export declare class NativeCacheKeepalive {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly auxiliary: NativeAuxiliaryRequests;
    readonly callbacks: Callbacks;
    readonly clock: KeepaliveClock;
    constructor(ctx: Context, store: SqliteFusionStore, auxiliary: NativeAuxiliaryRequests, callbacks: Callbacks, clock?: KeepaliveClock);
    stopSession(sessionId: string, reason: string): Promise<void>;
    stopTask(taskId: TaskId, reason: string): Promise<void>;
    /** Called again after asynchronous context measurement, before spend admission. */
    assertRequest(agent: Agent, request: GenerateOptions): void;
    install(): void;
    close(): Promise<void>;
}
export {};
