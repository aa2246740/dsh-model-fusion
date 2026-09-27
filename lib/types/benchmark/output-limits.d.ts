import type { Context } from '@deepseek-ai/cordis';
import type { PairProfile, Role } from '../contracts.js';
export interface BenchmarkOutputLimits {
    policy: 'role-route-auto-v1';
    roles: Record<Role, {
        provider: string;
        model: string;
        contextWindow: number;
        adapterDefault: number | null;
        testedCap: number | null;
        fallback: number;
        maxTokens: number;
    }>;
}
/** Run before preregistration, then compare the exact snapshot before spending.
 * Every treatment uses the same role's automatic product allowance; the profile
 * reservation is a fallback, not a universal per-request cap.
 */
export declare function resolveBenchmarkOutputLimits(ctx: Context, profile: PairProfile): Promise<BenchmarkOutputLimits>;
