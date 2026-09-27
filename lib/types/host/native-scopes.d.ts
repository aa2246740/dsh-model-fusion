import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { PhysicalRoute, Role } from '../contracts.js';
import type { SessionBinding } from './bindings.js';
export interface FusionScopeCallbacks {
    route?(binding: SessionBinding, role: Role): PhysicalRoute;
    beforeTurn?(agent: Agent, binding: SessionBinding, role: Role, turn: number): SessionBinding;
    taskContext?(agent: Agent, binding: SessionBinding, role: Role): UserMessage | undefined;
    beforeStep?(agent: Agent, binding: SessionBinding, role: Role): void;
    projectMessage?(agent: Agent, binding: SessionBinding, role: Role, message: UserMessage): UserMessage;
    /** All independent pause, budget, recovery and unknown-effect gates are checked here. */
    canAccess?(agent: Agent, binding: SessionBinding, role: Role): string | undefined;
    /** Shared gates plus limits that apply only to admitting a new generation. */
    canRequest(agent: Agent, binding: SessionBinding, role: Role): string | undefined;
    canExecute(exec: Readonly<ToolExecution>, binding: SessionBinding, role: Role): string | undefined;
    beforeRequest(agent: Agent, turn: number, step: number, binding: SessionBinding, role: Role): void;
    /** Disclosed context window for this physical model, read when the request is built. */
    modelLimits?(provider: string, model: string): Promise<{
        contextWindow: number;
        defaultMaxTokens?: number;
        testedOutputCap?: number;
    }>;
    /** Read-stage tools, presented natively. Undefined restores the native composition. */
    readOnlyTools?(agent: Agent, binding: SessionBinding, role: Role): readonly string[] | undefined;
    installTools(scope: Context, agent: Agent, binding: SessionBinding, role: Role): readonly (() => void)[];
}
/** Physical routing, prompt and tools live in the exact native Agent scope. */
export declare class NativeFusionScopes {
    #private;
    private readonly callbacks;
    constructor(callbacks: FusionScopeCallbacks);
    get(agent: Agent): {
        binding: SessionBinding;
        role: Role;
    } | undefined;
    assertReady(agent: Agent): void;
    install(agent: Agent, binding: SessionBinding, role: Role): void;
    /** Refresh at the persisted state transition, before native prompt providers run. */
    refreshTools(agent: Agent): void;
    /**
     * Caller owns quiescence and the original session-controller model selection.
     * Removing these listeners reveals that existing selection; it does not mutate
     * a request header or fabricate a replacement global default.
     */
    detach(agent: Agent): void;
}
