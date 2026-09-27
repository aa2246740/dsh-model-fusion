import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Role, TaskId } from '../contracts.js';
import type { CanonicalBill, UsageLedgerV2 } from '../usage/ledger.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { NativeAuxiliaryRequests } from './native-auxiliary.js';
export interface UsageOwner {
    readonly taskId: TaskId;
    readonly role: Role;
}
/** DSH counters are disjoint; missing provider fields retain unknown applicability. */
export declare function billFromNativeUsage(usage: TokenUsage | undefined): CanonicalBill;
export interface NativeUsageRecord {
    schemaVersion: 1;
    taskId: TaskId;
    sessionId: string;
    role: Role;
    purpose: 'conversation' | 'compaction' | 'session-title' | 'cache-keepalive';
    /** Effective request envelope; Host compaction markers can retain their pre-routing cap. */
    maxOutputTokens: number | null;
    reasoningEffort?: string;
    auxiliary?: {
        seriesId: string;
        iteration: number;
    };
    nativeInvocationId: string;
    startedAt: string;
    endedAt: string | null;
    /** Entering a Host stream is observable; the adapter's HTTP retry count is not. */
    nativeStreamInvocations: 1;
    upstreamHttpCalls: null;
    outcome: 'entered' | 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | 'unknown';
    ledger: UsageLedgerV2;
    actualSubscriptionChargeUsd: null;
    apiEquivalentCostUsd: null;
}
/** Read-only stream observer. It neither changes requests nor orchestrates agents. */
export declare function observeNativeUsage(ctx: Context, store: SqliteFusionStore, ownerOf: (agent: Agent) => UsageOwner | undefined, auxiliary?: NativeAuxiliaryRequests): () => void;
