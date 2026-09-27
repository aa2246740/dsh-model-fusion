import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PhysicalRoute, Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
/** Explicit bounded authorization when the native provider exposes no reliable money meter. */
export interface NativeSpendingAuthorization {
    schemaVersion: 1;
    kind: 'native-fusion-requests';
    approved: true;
    authorizationId: string;
    approvedBy: string;
    expiresAt: string;
    routes: readonly PhysicalRoute[];
    maxNativeRequests: number;
    maxReservedOutputTokens: number;
    /** This cannot be represented as a hard dollar cap. */
    costPolicy: 'unknown-cost-acknowledged';
}
export declare function nativeAuthorization(raw: unknown): NativeSpendingAuthorization;
/** Called only by explicit human settings actions (save or limits), never by a model tool. */
export declare function authorizeConfiguredPair(store: SqliteFusionStore, routes: readonly PhysicalRoute[], limits: unknown): NativeSpendingAuthorization;
export declare class NativeRequestBudget {
    readonly store: SqliteFusionStore;
    readonly authorizationFile?: string | undefined;
    constructor(store: SqliteFusionStore, authorizationFile?: string | undefined);
    check(routes: readonly PhysicalRoute[]): NativeSpendingAuthorization;
    install(ctx: Context, owner: (agent: Agent) => {
        binding: SessionBinding;
        role: Role;
    } | undefined, onBlocked?: (binding: SessionBinding, error: unknown) => void): () => void;
    reserve(route: PhysicalRoute, maxOutputTokens: number): void;
}
