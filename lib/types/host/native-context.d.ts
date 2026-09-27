import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { PhysicalRoute, Role, TokenMeasurement } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
import { type NativeTaskContext } from './native-task-context.js';
import type { NativeAuxiliaryRequests } from './native-auxiliary.js';
type Owner = {
    binding: SessionBinding;
    role: Role;
};
interface ContextCheck {
    route: PhysicalRoute;
    measurement: TokenMeasurement;
    budget: number;
    purpose: GenerateOptions['purpose'] | 'conversation' | 'cache-keepalive';
    logRevision: number;
    nativeBaseline: string;
    minimumRetainedInputTokens: number;
}
/** Optional summary routing, then final admission and the Host's single compaction owner. */
export declare class NativeContextGuard {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly owner: (agent: Agent) => Owner | undefined;
    readonly blocked: (owner: Owner, reason: string) => void;
    readonly taskContext?: NativeTaskContext | undefined;
    readonly auxiliary?: NativeAuxiliaryRequests | undefined;
    readonly route?: ((binding: SessionBinding, role: Role) => PhysicalRoute) | undefined;
    constructor(ctx: Context, store: SqliteFusionStore, owner: (agent: Agent) => Owner | undefined, blocked: (owner: Owner, reason: string) => void, taskContext?: NativeTaskContext | undefined, auxiliary?: NativeAuxiliaryRequests | undefined, route?: ((binding: SessionBinding, role: Role) => PhysicalRoute) | undefined);
    measure(agent: Agent, owner: Owner, request: GenerateOptions): Promise<ContextCheck>;
    install(admit: (agent: Agent, owner: Owner, request: GenerateOptions) => void, ready: (agent: Agent, request: GenerateOptions) => void): () => void;
}
export {};
