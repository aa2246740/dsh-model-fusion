import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FusionEvent, Role, TaskId } from '../contracts.js';
import { WorkspaceWriteLease } from '../execution/write-lease.js';
import type { ResolvedProfile } from '../profile/resolve.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { TaskState } from '../task/state.js';
import { BindingRepository } from './bindings.js';
import type { SessionBinding } from './bindings.js';
import type { CheckDefinition } from './native-checks.js';
import { NativeFusionScopes } from './native-scopes.js';
import { NativeModelControl } from './native-model-control.js';
import { NativeWorkflow } from './native-workflow.js';
import { NativeRoleSandbox } from './native-role-sandbox.js';
import { NativeOnDemandContext } from './native-on-demand-context.js';
import { NativeTaskContext } from './native-task-context.js';
import { NativeApprovals } from './native-approvals.js';
import { NativeEffects } from './native-effects.js';
import { NativeCacheKeepalive } from './native-keepalive.js';
import type { KeepaliveClock } from './native-keepalive.js';
import { NativeWorkerTransport } from './native-worker.js';
import { NativeFusionActivity } from './native-activity.js';
import { CachePolicy } from './cache-policy.js';
import type { ChangeBase } from './change-evidence.js';
export interface CoordinatorOptions {
    profile: ResolvedProfile;
    workerTools: readonly string[];
    /** Must validate existing authorization and durably reserve this actual request. */
    authorizeRequest(agent: Agent, binding: SessionBinding, role: Role, turn: number, step: number): void;
    /** Actual native stream admission, including auxiliary compaction calls. */
    resumeAuthorization?(binding: SessionBinding): string;
    reserveRequest?(request: GenerateOptions, binding: SessionBinding, role: Role): void;
    leaseRoot?: string;
    maxWorkerSteps?: number;
    maxReworkRounds?: number;
    commandMaxSeconds?: number;
    /** Test clock only; production retains the recovered fixed schedule. */
    keepaliveClock?: KeepaliveClock;
}
/** At least a sentence that is not a stock stub. */
export declare function substantiveReview(reason: string): boolean;
type LooseCheck = {
    command: string;
    id?: string;
    description?: string;
    parser?: CheckDefinition['parser'];
    kind?: CheckDefinition['kind'];
    timeoutSeconds?: number;
    definitionPaths?: readonly string[];
    baseline?: CheckDefinition['baseline'];
};
/** Fill the defaults a Lead may omit; an explicit test kind without a parser still fails in freezeChecks. */
export declare function normalizeChecks(raw: readonly LooseCheck[]): CheckDefinition[];
/** Consecutive read-only calls allowed before a model must act; the Lead delegates broad reading. */
export declare const READ_STREAK: Record<Role, number>;
/** A few lines stay natural for the Lead; anything larger goes to the Sidekick. */
export declare const LEAD_DIRECT_WRITE: {
    readonly perCall: 30;
    readonly perTask: 80;
};
/** Lines a Lead tool call would write; 0 for reads and ordinary commands. */
export declare function directWriteLines(exec: Readonly<ToolExecution>): number;
/**
 * The Worker is the cheap model: a real task needs room to explore, run and fix.
 * Stopping it early pushes work back to the expensive Lead or the user.
 */
export declare const DEFAULT_POLICY: {
    readonly maxWorkerSteps: 150;
    readonly maxReworkRounds: 3;
    readonly commandMaxSeconds: 600;
};
interface DelegateInput {
    goal: string;
    brief: string;
    constraints: string[];
    allowedPaths: string[];
    checks: CheckDefinition[];
    block?: boolean;
    /** Verbatim quotes of the user's hard requirements; frozen as user-provenance constraints. */
    requirements?: string[];
}
/** Whitespace-insensitive, otherwise exact: a requirement must be the user's own words. */
export declare const normalizeQuote: (text: string) => string;
/** Literal code spans (`like this`) a requirement asks for; a candidate that omits them gets flagged. */
export declare const literalSpans: (text: string) => string[];
/**
 * Existing test files whose original lines were removed or changed (pure additions are not listed). A Worker
 * that rewrites an old test to fit its change hides a regression the maintainers' test would catch
 * (round 4, canvasapi): the Lead must look at these before accepting.
 */
export declare function rewrittenTests(store: SqliteFusionStore, taskId: TaskId, root: string, changeBase: ChangeBase | undefined, changes: readonly string[]): {
    path: string;
    removedLines: number;
}[];
/** Rework rounds after which a still-failing work order unlocks Lead takeover (enforced-v3). */
export declare const ESCALATE_AFTER_REWORKS = 2;
/** Lead takeover submissions allowed per escalated work order. */
export declare const MAX_LEAD_SUBMISSIONS = 3;
/** Native AgentLoop owns work; optional auxiliary calls use the public LLM service. */
export declare class FusionCoordinator {
    #private;
    readonly ctx: Context;
    readonly store: SqliteFusionStore;
    readonly options: CoordinatorOptions;
    readonly bindings: BindingRepository;
    readonly scopes: NativeFusionScopes;
    readonly transport: NativeWorkerTransport;
    readonly activity: NativeFusionActivity;
    readonly leases: WorkspaceWriteLease;
    readonly taskContext: NativeTaskContext;
    readonly onDemand: NativeOnDemandContext;
    readonly approvals: NativeApprovals;
    readonly effects: NativeEffects;
    readonly keepalive: NativeCacheKeepalive;
    /** Per-model cache keepalive settings, evidence and defaults (shared with the settings API). */
    readonly cachePolicy: CachePolicy;
    readonly modelControl: NativeModelControl;
    readonly workflow: NativeWorkflow;
    readonly roleSandbox: NativeRoleSandbox;
    constructor(ctx: Context, store: SqliteFusionStore, options: CoordinatorOptions);
    state(id: TaskId): TaskState;
    append<T extends FusionEvent['type']>(id: TaskId, type: T, payload: Extract<FusionEvent, {
        type: T;
    }>['payload']): TaskState;
    owner(agent: Agent): {
        binding: SessionBinding;
        role: Role;
    } | undefined;
    select(agent: Agent, resolved?: ResolvedProfile): Promise<void>;
    /** Only at idle selection or native running reservation, before prompt assembly. */
    selectBeforeAssembly(agent: Agent, resolved: ResolvedProfile): void;
    clear(agent: Agent): Promise<void>;
    wait(agent: Agent, exec: ToolRunContext): Promise<string>;
    delegate(agent: Agent, args: DelegateInput, exec: ToolRunContext, mode?: 'explore' | 'implement' | 'text'): Promise<string>;
    rework(agent: Agent, feedback: string, exec: ToolRunContext, block?: boolean, checks?: readonly CheckDefinition[], addAllowedPaths?: readonly string[]): Promise<string>;
    review(agent: Agent, decision: 'accept' | 'rework' | 'needs-decision', reason: string, exec: ToolRunContext, verdicts?: readonly {
        index: number;
        met: boolean;
        evidence: string;
    }[]): string;
    pause(agent: Agent): Promise<void>;
    resume(agent: Agent, authorizationId: string): Promise<void>;
    /** Human command only. Never exposed as an LLM tool or triggered by a dead PID alone. */
    reconcile(agent: Agent, inspection: {
        commandId: string;
        note: string;
        effectsStopped?: boolean;
    }): Promise<void>;
    close(): Promise<void>;
}
export {};
