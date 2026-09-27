import type { ControlView } from './host/native-model-control.js';
import type { PhysicalRoute, Role, TokenMeasurement, VerificationLevel } from './contracts.js';
/** Bounded, read-only UI projection. No prompts, tool arguments or credentials. */
export interface FusionStatus {
    schemaVersion: 1;
    sessionId: string;
    selected: boolean;
    observedAt: string;
    task?: {
        id: string;
        revision: number;
        stage: string;
        detail: string | null;
        /** English copies for an English DSH; optional so older records still read. */
        stageEn?: string;
        detailEn?: string | null;
        attention: boolean;
        verification: VerificationLevel;
        workerId: string | null;
        modelControl?: ControlView;
        models: {
            lead: PhysicalRoute;
            worker: PhysicalRoute;
            compactor: PhysicalRoute | null;
        };
        usage: {
            calls: number;
            finalCalls: number;
            provisionalCalls: number;
            unreportedCalls: number;
            compactionCalls: number;
            keepaliveCalls: number;
            /** Known subtotals only; missing request fields never become zero totals. */
            input: UsageSubtotal;
            cacheRead: UsageSubtotal;
            output: UsageSubtotal;
            actualBilledUsd: null;
            upstreamHttpCalls: null;
            /** Where the tokens went: the point of Fusion is that most land on the cheaper Worker. */
            byRole: Record<Role, RoleUsage>;
        };
        /** Checks frozen on the current work order; 0 means the Lead review was the only verification. */
        automatedChecks: number | null;
        requests: {
            id: string;
            role: Role;
            purpose: string;
            provider: string;
            model: string;
            outcome: string;
            authority: 'none' | 'provisional' | 'final';
            startedAt: string;
        }[];
        tools: {
            id: string;
            role: Role;
            name: string;
            state: string;
            failed: boolean;
            startedAt: string;
        }[];
        contexts: {
            role: Role;
            purpose: string;
            inputTokens: number;
            budget: number;
            quality: TokenMeasurement['quality'];
            admitted: boolean;
            checkedAt: string;
        }[];
        pendingApprovals: number;
        unsettledTools: number;
    };
}
export interface RoleUsage {
    calls: number;
    input: UsageSubtotal;
    cacheRead: UsageSubtotal;
    output: UsageSubtotal;
}
export interface UsageSubtotal {
    knownTokens: number;
    reportedRequests: number;
    totalRequests: number;
}
