import type { PairProfile, PhysicalRoute } from '../contracts.js';
/** A separate summary model is never inferred from a provider name or enabled by default. */
export declare function compactorChoice(value: unknown): PairProfile['compactor'];
/** All physical routes in a frozen configuration share the same explicit spending authorization. */
export declare function profileRoutes(profile: Pick<PairProfile, 'lead' | 'worker' | 'compactor'>): PhysicalRoute[];
