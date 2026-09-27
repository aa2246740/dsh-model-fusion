import { describe, expect, it } from 'vitest'
import { FusionError, SPEND_UNAUTHORIZED } from '../src/errors.js'
import { BudgetLedger, loadSpendingAuthorization } from '../src/usage/budget.js'
import { apiEquivalentUsd, mergeUsageObservations, normalizeUsage, observationFromNormalized, priceUsage } from '../src/usage/normalize.js'
import { USAGE_LEDGER_REQUIRED } from '../src/errors.js'
import { ingestDurable, known, newLedger, projectLedger } from '../src/usage/ledger.js'
import { expectCode } from './helpers.js'

describe('normalizeUsage', () => {
  it('subtracts inclusive cached input once', () => {
    const usage = normalizeUsage({
      inputTokens: 100,
      cacheReadTokens: 40,
      inputIncludesCacheRead: true,
      outputTokens: 10,
    })
    expect(usage.uncachedInput).toBe(60)
    expect(usage.cacheRead).toBe(40)
  })

  it('keeps exclusive input and cache read separate', () => {
    const usage = normalizeUsage({
      inputTokens: 100,
      cacheReadTokens: 40,
      inputIncludesCacheRead: false,
    })
    expect(usage.uncachedInput).toBe(100)
    expect(usage.cacheRead).toBe(40)
  })

  it('does not add reasoning tokens onto output when they are already included', () => {
    const usage = normalizeUsage({
      outputTokens: 80,
      reasoningTokens: 30,
      outputIncludesReasoning: true,
    })
    expect(usage.output).toBe(80)
    expect(usage.reasoningOutputSubset).toBe(30)
    expect(usage.reasoningSeparate).toBeNull()
    expect(usage.reasoningUnspecified).toBeNull()
  })

  it('keeps cache writes in distinct TTL buckets', () => {
    const usage = normalizeUsage({
      cacheWriteByTtl: { '5m': 10, '1h': 4 },
    })
    expect(usage.cacheWrite).toEqual({ '5m': 10, '1h': 4 })
  })

  it('leaves missing fields null instead of zero', () => {
    expect(normalizeUsage({}).uncachedInput).toBeNull()
    expect(normalizeUsage({}).output).toBeNull()
    expect(apiEquivalentUsd(normalizeUsage({ outputTokens: 10 }), undefined)).toBeNull()
    expect(apiEquivalentUsd(normalizeUsage({ outputTokens: 10 }), {
      digest: 'x',
      outputPerMillion: null,
    })).toBeNull()
  })

  it('refuses the retired implicit merge wrapper', () => {
    const once = normalizeUsage({ inputTokens: 5, outputTokens: 2 })
    expectCode(() => mergeUsageObservations(once, once), USAGE_LEDGER_REQUIRED)
  })

  it('dedupes the same observation id on an explicit ledger', () => {
    const once = normalizeUsage({ inputTokens: 5, outputTokens: 2 })
    const key = { provider: 'p', model: 'm', requestId: 'r', attemptId: 'a', contractDigest: 'c' }
    const observation = observationFromNormalized(once, key, { observationId: 'same', sequence: 1, source: 'partial' })
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observation)
    ledger = ingestDurable(ledger, observation)
    expect(projectLedger(ledger).bill?.output).toEqual(known(2))
  })

  it('computes api-equivalent dollars from a frozen card when every bucket is priced', () => {
    const usage = normalizeUsage({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    })
    expect(apiEquivalentUsd(usage, {
      digest: 'card',
      uncachedInputPerMillion: '3',
      outputPerMillion: '15',
    })).toBe('10.5')
  })

  it('keeps known zeros complete even when a rate card field is missing', () => {
    expect(apiEquivalentUsd(normalizeUsage({ inputTokens: 0, outputTokens: 0 }), {
      digest: 'card',
    })).toBe('0')
  })

  it('does not invent a cache-inclusion split when the contract is omitted', () => {
    expect(priceUsage(normalizeUsage({
      inputTokens: 1000,
      cacheReadTokens: 800,
      outputTokens: 100,
    }), {
      digest: 'card',
      uncachedInputPerMillion: '1',
      cacheReadPerMillion: '0.1',
      outputPerMillion: '5',
    }).totalUsd).toBeNull()
  })
})

describe('BudgetLedger', () => {
  it('refuses work without an approved authorization', () => {
    const ledger = new BudgetLedger(loadSpendingAuthorization({
      schemaVersion: 1,
      approved: false,
      authorizationId: null,
      currency: 'USD',
      maximumTotal: null,
      allowedModels: [],
      expiresAt: null,
      approvedBy: null,
    }))
    expectCode(() => ledger.reserve(1), SPEND_UNAUTHORIZED)
  })

  it('atomically reserves so a second concurrent estimate cannot exceed the cap', () => {
    const ledger = new BudgetLedger({
      schemaVersion: 1,
      approved: true,
      authorizationId: 'auth-1',
      currency: 'USD',
      maximumTotal: '1',
      allowedModels: [],
      expiresAt: null,
      approvedBy: 'cola',
    })
    ledger.reserve(0.7)
    expect(() => ledger.reserve(0.7)).toThrowError(FusionError)
  })

  it('keeps the reservation when the final bill is unknown', () => {
    const ledger = new BudgetLedger({
      schemaVersion: 1,
      approved: true,
      authorizationId: 'auth-1',
      currency: 'USD',
      maximumTotal: '10',
      allowedModels: [],
      expiresAt: null,
      approvedBy: 'cola',
    })
    const reserved = ledger.reserve(2)
    ledger.settle(reserved, null)
    expect(ledger.reserved).toBe(2)
    expect(() => ledger.reserve(9)).toThrowError(FusionError)
  })
})
