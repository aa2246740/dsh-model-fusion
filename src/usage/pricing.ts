import { digestOf } from '../digest.js'
import { FusionError, USAGE_LEDGER_REQUIRED } from '../errors.js'
import {
  projectLedger,
  restoreLedger,
  type Count,
  type UsageLedgerV2,
} from './ledger.js'

export interface PriceRates {
  input?: string
  cachedInput?: string
  output?: string
  /** Explicit separate-reasoning rate; no assumed relationship to output price. */
  reasoning?: string
  cacheWrite?: Readonly<Record<string, string>>
}

export interface RequestQuote {
  authority: 'none' | 'provisional' | 'final'
  status: 'unknown' | 'provisional' | 'incomplete' | 'complete'
  totalUsd: string | null
  estimateUsd: string | null
  priceCardDigest: string
  missing: string[]
}

function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new FusionError(USAGE_LEDGER_REQUIRED, code)
}

/** 18 decimal places in USD: a rate with <=12 decimals per 1e6 tokens is exact. */
function rateUnits(rate: string): bigint {
  requireThat(/^\d+(?:\.\d{1,12})?$/.test(rate), 'INVALID_PRICE_RATE')
  const [whole, frac = ''] = rate.split('.')
  return BigInt(whole! + frac.padEnd(12, '0'))
}

function decimal(units: bigint): string {
  const div = 10n ** 18n
  const fraction = (units % div).toString().padStart(18, '0').replace(/0+$/, '')
  return `${units / div}${fraction ? `.${fraction}` : ''}`
}

export function quoteLedger(ledger: UsageLedgerV2, rates: PriceRates, priceCardDigest = digestOf(rates)): RequestQuote {
  const projection = projectLedger(restoreLedger(ledger))
  const bill = projection.bill
  const missing: string[] = []
  let units = 0n
  function add(count: Count, rate: string | undefined, name: string) {
    if (count.state === 'not_applicable') return
    if (count.state === 'unknown') {
      missing.push(`${name}:unknown`)
      return
    }
    requireThat(Number.isSafeInteger(count.tokens) && count.tokens >= 0, 'INVALID_COUNT')
    if (count.tokens === 0) return
    if (rate === undefined) {
      missing.push(`${name}:rate-missing`)
      return
    }
    units += BigInt(count.tokens) * rateUnits(rate)
  }
  if (!bill) {
    return {
      authority: projection.authority,
      status: 'unknown',
      totalUsd: null,
      estimateUsd: null,
      priceCardDigest,
      missing: ['no-bill'],
    }
  }
  add(bill.uncachedInput, rates.input, 'input')
  add(bill.cacheRead, rates.cachedInput, 'cache-read')
  add(bill.output, rates.output, 'output')
  if (bill.cacheWrite.kind === 'unknown') missing.push('cache-write:unknown')
  if (bill.cacheWrite.kind === 'aggregate') add(bill.cacheWrite.tokens, rates.cacheWrite?.[bill.cacheWrite.rateKey], 'cache-write')
  if (bill.cacheWrite.kind === 'details') {
    for (const [key, bucket] of Object.entries(bill.cacheWrite.buckets)) {
      add(bucket.tokens, rates.cacheWrite?.[bucket.rateKey], `cache-write:${key}`)
    }
  }
  if (bill.reasoning.kind === 'unknown') missing.push('reasoning-contract:unknown')
  if (bill.reasoning.kind === 'separate') add(bill.reasoning.tokens, rates.reasoning, 'reasoning')
  const complete = projection.authority === 'final' && missing.length === 0
  return {
    authority: projection.authority,
    status: complete ? 'complete' : projection.authority === 'final' ? 'incomplete' : 'provisional',
    totalUsd: complete ? decimal(units) : null,
    estimateUsd: decimal(units),
    priceCardDigest,
    missing,
  }
}
