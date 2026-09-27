import type { Context } from '@deepseek-ai/cordis'
import type { PairProfile, Role } from '../contracts.js'
import { requestOutputReservation } from '../context/guard.js'
import { resolveModelOutputLimits } from '../host/model-output.js'

export interface BenchmarkOutputLimits {
  policy: 'role-route-auto-v1'
  roles: Record<Role, {
    provider: string
    model: string
    contextWindow: number
    adapterDefault: number | null
    testedCap: number | null
    fallback: number
    maxTokens: number
  }>
}

/** Run before preregistration, then compare the exact snapshot before spending.
 * Every treatment uses the same role's automatic product allowance; the profile
 * reservation is a fallback, not a universal per-request cap.
 */
export async function resolveBenchmarkOutputLimits(ctx: Context, profile: PairProfile): Promise<BenchmarkOutputLimits> {
  const roles = {} as BenchmarkOutputLimits['roles']
  for (const role of ['lead', 'worker'] as const) {
    const { provider, model } = profile[role]
    const { contextWindow, defaultMaxTokens, testedOutputCap } = await resolveModelOutputLimits(ctx, provider, model)
    const fallback = profile.context[role].reserveOutputTokens
    roles[role] = { provider, model, contextWindow, adapterDefault: defaultMaxTokens ?? null, testedCap: testedOutputCap ?? null,
      fallback, maxTokens: requestOutputReservation(contextWindow, undefined, defaultMaxTokens, testedOutputCap, fallback) }
  }
  return { policy: 'role-route-auto-v1', roles }
}
