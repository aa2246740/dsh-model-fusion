import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { TaskState } from '../task/state.js';
import type { NativeUsageRecord } from './native-usage.js';
import { type Count } from '../usage/ledger.js';
export interface TaskSummary {
    id: string;
    sessionId: string;
    seq: number;
    createdAt: string;
    updatedAt: string;
    title: string;
    phase: string;
    verification: string;
    mode: string;
}
export declare function taskSummary(state: TaskState, createdAt: string, updatedAt: string): TaskSummary;
export interface UsageSummary {
    id: string;
    taskId: string;
    role: string;
    provider: string;
    model: string;
    purpose: string;
    startedAt: string;
    outcome: string;
    authority: 'none' | 'provisional' | 'final';
    input: Count;
    output: Count;
    cacheRead: Count;
}
export declare function usageSummary(row: NativeUsageRecord): UsageSummary;
/** Once at plugin startup; GET never writes, starts agents, or scans full task/usage snapshots. */
export declare function backfillHistory(store: SqliteFusionStore): void;
export interface HistoryTotals {
    calls: number;
    final: number;
    provisional: number;
    unreported: number;
    input: {
        known: number;
        reported: number;
    };
    output: {
        known: number;
        reported: number;
    };
    cacheRead: {
        known: number;
        reported: number;
    };
}
/** How often the Host unlocked Lead takeover (enforced-v3), by reason. */
export interface TakeoverTotals {
    total: number;
    tasks: number;
    reasons: Record<string, number>;
}
export interface HistoryView {
    observedAt: string;
    totalTasks: number;
    tasks: (TaskSummary & {
        usage: HistoryTotals;
        takeovers: number;
    })[];
    nextCursor: string | null;
    takeovers: TakeoverTotals;
    totals: HistoryTotals;
    groups: ({
        role: string;
        provider: string;
        model: string;
        purpose: string;
    } & HistoryTotals)[];
    actualBilledUsd: null;
    savingsPercent: null;
    upstreamHttpCalls: null;
}
export declare function readHistory(store: SqliteFusionStore, cursor?: string, limit?: number): HistoryView;
