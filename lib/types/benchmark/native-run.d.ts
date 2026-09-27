import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TaskId } from '../contracts.js';
import { NativeRequestBudget } from '../host/native-budget.js';
import type { NativeUsageRecord } from '../host/native-usage.js';
import type { ResolvedProfile } from '../profile/resolve.js';
import { type BenchmarkOutputLimits } from './output-limits.js';
export interface NativeBenchmarkOptions {
    runId: string;
    variant: 'lead_only' | 'worker_only' | 'worker_selfreview' | 'naive' | 'fusion';
    dataKind: 'real' | 'synthetic';
    /** Version read by the trusted launcher from the loaded artifact's metadata. */
    engineVersion?: string;
    workspace: string;
    /** Fresh directory, outside the candidate's filesystem. Never reused. */
    output: string;
    prompt: string;
    profile: ResolvedProfile;
    /** Required for real runs: exact public model limits frozen before the attempt. */
    outputLimits?: BenchmarkOutputLimits;
    /** One campaign-wide ledger, so attempts cannot reset the approved limit. */
    budget: NativeRequestBudget;
    maxRequests: number;
    timeoutMs: number;
}
/**
 * Run one fresh attempt through the same native AgentLoop and FusionCoordinator
 * as the product. The caller composes public Host services and a sandboxed shell;
 * this function does not implement another LLM/tool loop or grade candidate code.
 */
export declare function runNativeBenchmark(ctx: Context, options: NativeBenchmarkOptions): Promise<{
    status: string;
    failure: string | null;
    endReason: import("@deepseek-ai/dsh-session").TurnEndReason | null;
    phases: {
        stage: "implementation" | "self_review";
        completed: boolean;
        nativeRequests: number;
        endReason: unknown;
    }[];
    deliveredSnapshot: import("../host/workspace.js").WorkspaceSnapshot;
    fusionState: import("../index.js").TaskState | null;
    usage: NativeUsageRecord[];
    actualBilledUsd: null;
    apiEquivalentUsd: null;
    upstreamHttpCalls: null;
    naiveDelegations?: import("./naive.js").NaiveDelegation[] | undefined;
    schemaVersion: number;
    runId: string;
    variant: "lead_only" | "worker_only" | "worker_selfreview" | "naive" | "fusion";
    dataKind: "real" | "synthetic";
    startedAt: string;
    endedAt: string;
    wallSeconds: number;
    parentSessionId: SessionId;
    workerSessionId: string | null;
    taskId: TaskId;
    nativeRequests: number;
    protocolComplete: boolean;
    artifactPass: null;
    workerParentSessionId: SessionId | null;
    workerSessions: {
        sessionId: SessionId;
        parentSessionId: SessionId | undefined;
        eventsFile: string;
    }[];
}>;
export { NativeRequestBudget };
