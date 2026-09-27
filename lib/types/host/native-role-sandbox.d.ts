import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'sandbox/mode': {
            mode: Mode;
            source?: 'delegation';
        };
    }
}
export declare const roleSeparated: (binding: SessionBinding) => boolean;
/**
 * Role separation enforced below the prompt: the Lead's session runs under the
 * Host's own read-only sandbox (bash and filesystem are refused by the OS
 * backend), while the Sidekick keeps the mode the user chose. The plugin never
 * widens a mode: the Sidekick gets exactly the user's mode, and leaving Fusion
 * restores it on the conversation. Only public session events are written.
 */
export declare class NativeRoleSandbox {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly binding: (sessionId: string) => SessionBinding | undefined;
    constructor(ctx: Context, store: SqliteFusionStore, binding: (sessionId: string) => SessionBinding | undefined);
    /**
     * Called before every model request of an enforced-v3 role. `writer` is true only while the Lead holds the
     * write lease through a Host-unlocked takeover; it then runs under the user's own mode, like the Sidekick.
     */
    ensure(agent: Agent, binding: SessionBinding, role: Role, writer?: boolean): void;
    /**
     * Frozen acceptance checks are plugin-issued and nested in a Lead tool call, so
     * they would inherit the Lead's read-only session. They run under the user's
     * mode; the Lead's own shell stays refused meanwhile because leadShellProblem
     * requires an actual read-only resolution at execution time.
     */
    whileChecking<T>(agent: Agent, binding: SessionBinding, run: () => Promise<T>): Promise<T>;
    /** A Lead shell is allowed only when the Host will actually run it read-only and without escalation. */
    leadShellProblem(exec: Readonly<ToolExecution>): string | undefined;
    /** Put the user's own mode back when the conversation leaves Fusion. */
    restore(agent: Agent): void;
    /** A mode switch the user makes while Fusion is selected becomes the Sidekick's mode; the Lead stays read-only. */
    install(): () => void;
}
export {};
