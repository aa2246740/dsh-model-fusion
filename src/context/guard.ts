import type { RoleContextPolicy, TokenMeasurement } from '../contracts.js'
import { digestOf } from '../digest.js'
import { FUSION_CONTEXT_BUDGET, FusionError } from '../errors.js'

export interface RequestParts {
  systemTokens: number
  messageTokens: number
  toolSchemaTokens: number
  cacheReadTokens: number
  reservedOutputTokens: number
  contextWindow: number
  quality: TokenMeasurement['quality']
}

export function safetyTokens(contextWindow: number, policy: RoleContextPolicy, quality: TokenMeasurement['quality']): number {
  const fromFraction = Math.ceil(contextWindow * policy.safetyFraction)
  const base = Math.max(policy.minSafetyTokens, fromFraction)
  if (quality === 'heuristic') return Math.max(base, Math.ceil(base * 1.25))
  return base
}

/** Output reservation that fits the disclosed window. Leaves half the usable window for input. */
export function fittedOutputReservation(contextWindow: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) throw new Error('The configured model does not disclose a usable context window')
  const safety = Math.max(2_048, Math.ceil(contextWindow * 0.05))
  const usable = contextWindow - safety
  if (usable < 2) throw new Error('The configured model context window cannot reserve output')
  return Math.floor(usable / 2)
}

export function requestOutputReservation(contextWindow: number, requested?: number, adapterDefault?: number,
  testedCap?: number, fallback = 8_000): number {
  const fitted = fittedOutputReservation(contextWindow)
  for (const limit of [requested, adapterDefault, testedCap, fallback]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid model output token limit')
  }
  // The context window alone does not disclose a provider's output allowance.
  // RC.2 exposes configured defaults, not a universal maximum-output field.
  // With no disclosed/tested cap, use a bounded policy default, never half of
  // a million-token input window as a fabricated provider output allowance.
  return Math.min(requested ?? adapterDefault ?? testedCap ?? fallback,
    adapterDefault ?? Infinity, testedCap ?? Infinity, fitted)
}

export function inputBudget(policy: RoleContextPolicy, contextWindow: number, maxOutput: number, quality: TokenMeasurement['quality'] = 'exact'): number {
  const safety = safetyTokens(contextWindow, policy, quality)
  const hard = contextWindow - maxOutput - safety
  return Math.max(0, Math.min(policy.targetInputTokens, hard))
}

export function measureRequest(parts: RequestParts, policy: RoleContextPolicy): TokenMeasurement {
  const inputTokens = parts.systemTokens + parts.messageTokens + parts.toolSchemaTokens + parts.cacheReadTokens
  return {
    inputTokens,
    reservedOutputTokens: parts.reservedOutputTokens,
    contextWindow: parts.contextWindow,
    safetyTokens: safetyTokens(parts.contextWindow, policy, parts.quality),
    quality: parts.quality,
    requestDigest: digestOf(parts),
  }
}

export function assertFinalBudget(measurement: TokenMeasurement, policy: RoleContextPolicy): void {
  const budget = inputBudget(policy, measurement.contextWindow, measurement.reservedOutputTokens, measurement.quality)
  if (measurement.inputTokens > budget) {
    throw new FusionError(
      FUSION_CONTEXT_BUDGET,
      `final request ${measurement.inputTokens} exceeds budget ${budget} (${measurement.quality})`,
    )
  }
}

export interface RecoveryAttempt {
  readonly projectionTokens: number
}

export function boundedOverflowRecovery(attempts: readonly RecoveryAttempt[]): 'continue' | 'needs-decision' {
  if (attempts.length > 2) return 'needs-decision'
  if (attempts.length === 2 && attempts[1]!.projectionTokens >= attempts[0]!.projectionTokens) return 'needs-decision'
  return 'continue'
}
