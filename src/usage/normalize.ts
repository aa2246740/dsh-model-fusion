import type { NormalizedUsage, ReasoningBilling, UsageApplicability, UsdDecimal } from '../contracts.js'
import { UsdDecimal as usd } from '../contracts.js'
import { FusionError, USAGE_LEDGER_REQUIRED } from '../errors.js'
import {
  known,
  na,
  splitInput,
  unknown,
  type CanonicalBill,
  type Count,
  type UsageObservation,
  type UsageRequestKey,
} from './ledger.js'

export interface RawUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  cacheWriteByTtl?: Readonly<Record<string, number | null>>
  reasoningTokens?: number | null
  /** When true, inputTokens already includes cacheReadTokens. */
  inputIncludesCacheRead?: boolean
  /** When true, outputTokens already includes reasoningTokens. */
  outputIncludesReasoning?: boolean
}

export interface PriceCard {
  digest: string
  uncachedInputPerMillion?: string | null
  cacheReadPerMillion?: string | null
  cacheWritePerMillion?: Readonly<Record<string, string | null>>
  outputPerMillion?: string | null
  reasoningPerMillion?: string | null
}

export type UsageObservationKind = 'partial' | 'final'

export interface UsageObservationMeta {
  requestId?: string
  source?: UsageObservationKind
  sequence?: number
  cumulative?: boolean
  observationId?: string
}

export type UsagePriceStatus = 'complete' | 'incomplete' | 'unknown'

export interface UsagePrice {
  status: UsagePriceStatus
  /** Complete total only. Never a partial stand-in for ranking. */
  totalUsd: UsdDecimal | null
  /** Lower bound of priced known buckets. Not a substitute total. */
  observedUsd: UsdDecimal | null
  reasons: readonly string[]
}

function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`usage must be a finite nonnegative number, got ${value}`)
  return value
}

function applicability(value: number | null | undefined, present: boolean): UsageApplicability {
  if (!present) return 'not_applicable'
  if (value === null || value === undefined) return 'unknown'
  return 'known'
}

function toCount(value: number | null, status: UsageApplicability): Count {
  if (status === 'not_applicable') return na()
  if (status === 'unknown' || value === null) return unknown()
  return known(value)
}

function fromCount(value: Count): number | null {
  return value.state === 'known' ? value.tokens : null
}

function reasoningFromRaw(raw: RawUsage): ReasoningBilling {
  const present = Object.prototype.hasOwnProperty.call(raw, 'reasoningTokens')
  const tokens = finite(raw.reasoningTokens)
  if (raw.outputIncludesReasoning === true) return { kind: 'included', tokens }
  if (raw.outputIncludesReasoning === false) return { kind: 'separate', tokens }
  if (!present) return { kind: 'not_applicable', tokens: null }
  return { kind: 'unknown', tokens }
}

export function normalizeUsage(raw: RawUsage): NormalizedUsage {
  const cacheReadPresent = Object.prototype.hasOwnProperty.call(raw, 'cacheReadTokens')
  const cacheRead = finite(raw.cacheReadTokens)
  const input = finite(raw.inputTokens)
  const includesCache = raw.inputIncludesCacheRead ?? null
  const cacheReadStatus = applicability(raw.cacheReadTokens, cacheReadPresent)
  const split = splitInput(toCount(input, input === null ? 'unknown' : 'known'), toCount(cacheRead, cacheReadStatus), includesCache)
  const cacheWritePresent = Object.prototype.hasOwnProperty.call(raw, 'cacheWriteTokens')
    || Object.prototype.hasOwnProperty.call(raw, 'cacheWriteByTtl')
  let cacheWrite: Record<string, number | null> = {}
  let cacheWriteStatus: Record<string, UsageApplicability> = {}
  if (raw.cacheWriteByTtl) {
    cacheWrite = Object.fromEntries(Object.entries(raw.cacheWriteByTtl).map(([ttl, tokens]) => [ttl, finite(tokens)]))
    cacheWriteStatus = Object.fromEntries(
      Object.entries(raw.cacheWriteByTtl).map(([ttl, tokens]) => [ttl, applicability(tokens, true)]),
    )
  } else if (cacheWritePresent) {
    cacheWrite = { default: finite(raw.cacheWriteTokens) }
    cacheWriteStatus = { default: applicability(raw.cacheWriteTokens, true) }
  }
  const output = finite(raw.outputTokens)
  const reasoningBilling = reasoningFromRaw(raw)
  return {
    uncachedInput: fromCount(split),
    cacheRead,
    cacheReadStatus,
    cacheWrite,
    cacheWriteStatus,
    output,
    reasoningOutputSubset: reasoningBilling.kind === 'included' ? reasoningBilling.tokens : null,
    reasoningSeparate: reasoningBilling.kind === 'separate' ? reasoningBilling.tokens : null,
    reasoningUnspecified: reasoningBilling.kind === 'unknown' ? reasoningBilling.tokens : null,
    reasoningBilling,
    inputIncludesCacheRead: includesCache,
  }
}

function cacheWritesFromUsage(usage: NormalizedUsage): CanonicalBill['cacheWrite'] {
  const keys = Object.keys(usage.cacheWrite)
  if (!keys.length) return { kind: 'not_applicable' }
  if (keys.some(key => usage.cacheWriteStatus[key] === 'unknown' || usage.cacheWrite[key] === null)) {
    if (keys.length === 1 && keys[0] === 'default') {
      return usage.cacheWriteStatus.default === 'unknown' || usage.cacheWrite.default === null
        ? { kind: 'unknown' }
        : { kind: 'aggregate', rateKey: 'default', tokens: toCount(usage.cacheWrite.default ?? null, usage.cacheWriteStatus.default ?? 'known') }
    }
  }
  if (keys.length === 1 && keys[0] === 'default') {
    return {
      kind: 'aggregate',
      rateKey: 'default',
      tokens: toCount(usage.cacheWrite.default ?? null, usage.cacheWriteStatus.default ?? (usage.cacheWrite.default === null ? 'unknown' : 'known')),
    }
  }
  return {
    kind: 'details',
    buckets: Object.fromEntries(keys.map(key => [key, {
      rateKey: key,
      tokens: toCount(usage.cacheWrite[key] ?? null, usage.cacheWriteStatus[key] ?? (usage.cacheWrite[key] === null ? 'unknown' : 'known')),
    }])),
  }
}

function billFromUsage(usage: NormalizedUsage): CanonicalBill {
  const billing = usage.reasoningBilling ?? (
    usage.reasoningOutputSubset !== null
      ? { kind: 'included' as const, tokens: usage.reasoningOutputSubset }
      : usage.reasoningSeparate !== null
        ? { kind: 'separate' as const, tokens: usage.reasoningSeparate }
        : usage.reasoningUnspecified !== null
          ? { kind: 'unknown' as const, tokens: usage.reasoningUnspecified }
          : { kind: 'not_applicable' as const, tokens: null }
  )
  return {
    uncachedInput: toCount(usage.uncachedInput, usage.uncachedInput === null ? 'unknown' : 'known'),
    cacheRead: toCount(usage.cacheRead, usage.cacheReadStatus),
    output: toCount(usage.output, usage.output === null ? 'unknown' : 'known'),
    cacheWrite: cacheWritesFromUsage(usage),
    reasoning: {
      kind: billing.kind,
      tokens: billing.kind === 'not_applicable' ? na() : toCount(billing.tokens, billing.tokens === null ? 'unknown' : 'known'),
    },
  }
}

function observationMode(meta?: UsageObservationMeta): UsageObservation['mode'] {
  if (meta?.source === 'final') return 'final'
  if (meta?.cumulative === false) return 'delta'
  return 'snapshot'
}

function asObservation(usage: NormalizedUsage, meta: UsageObservationMeta | undefined, key: UsageRequestKey, side: 'first' | 'second'): UsageObservation {
  const bill = billFromUsage(usage)
  const sequence = meta?.sequence ?? (side === 'first' ? 0 : 1)
  return {
    id: meta?.observationId ?? `anon:${side}:${sequence}:${JSON.stringify(bill)}`,
    key,
    sequence,
    mode: observationMode(meta),
    bill,
  }
}

export function observationFromNormalized(
  usage: NormalizedUsage,
  key: UsageRequestKey,
  meta: UsageObservationMeta & { id?: string },
): UsageObservation {
  return asObservation(usage, { ...meta, observationId: meta.id ?? meta.observationId }, key, 'first')
}

/**
 * Retired. Persist UsageLedgerV2 and quoteLedger(). A NormalizedUsage projection
 * is not enough history to replay a request bill.
 */
export function mergeUsageObservations(
  ..._args: unknown[]
): never {
  throw new FusionError(
    USAGE_LEDGER_REQUIRED,
    'persist UsageLedgerV2 with ingestDurable/restoreLedger; mergeUsageObservations cannot recover request history',
  )
}

function millionths(tokens: number, rate: string): bigint {
  const [whole, frac = ''] = rate.split('.')
  const digits = `${whole}${frac.padEnd(6, '0').slice(0, 6)}`
  const perMillion = BigInt(digits)
  return (BigInt(tokens) * perMillion) / 1_000_000n
}

function decimalFromMillionths(value: bigint): UsdDecimal {
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  const text = frac ? `${whole.toString()}.${frac}` : whole.toString()
  return usd(negative ? `-${text}` : text)
}

type BucketKind = 'required' | 'optional'

function priceBucket(
  tokens: number | null,
  rate: string | null | undefined,
  label: string,
  kind: BucketKind,
  parts: bigint[],
  reasons: string[],
): void {
  if (tokens === null) {
    if (kind === 'required') reasons.push(`${label} tokens unknown`)
    return
  }
  if (tokens === 0) return
  if (rate === null || rate === undefined) {
    reasons.push(`${label} rate missing`)
    return
  }
  parts.push(millionths(tokens, rate))
}

export function priceUsage(usage: NormalizedUsage, card: PriceCard | undefined): UsagePrice {
  if (!card) {
    return { status: 'unknown', totalUsd: null, observedUsd: null, reasons: ['no price card'] }
  }

  const parts: bigint[] = []
  const reasons: string[] = []
  const unreliableBound = usage.inputIncludesCacheRead === true && usage.cacheReadStatus !== 'known'
  if (unreliableBound) {
    reasons.push('input includes cache but the cache split is unknown; observed is not a reliable lower bound')
  }
  priceBucket(usage.uncachedInput, card.uncachedInputPerMillion, 'uncachedInput', 'required', parts, reasons)
  if (usage.cacheReadStatus === 'unknown') {
    reasons.push('cacheRead tokens unknown')
  } else if (usage.cacheReadStatus === 'known') {
    priceBucket(usage.cacheRead, card.cacheReadPerMillion, 'cacheRead', 'optional', parts, reasons)
  }
  priceBucket(usage.output, card.outputPerMillion, 'output', 'required', parts, reasons)
  for (const [ttl, tokens] of Object.entries(usage.cacheWrite)) {
    const status = usage.cacheWriteStatus[ttl] ?? (tokens === null ? 'unknown' : 'known')
    if (status === 'unknown') {
      reasons.push(`cacheWrite.${ttl} tokens unknown`)
      continue
    }
    if (status === 'not_applicable') continue
    priceBucket(tokens, card.cacheWritePerMillion?.[ttl] ?? card.cacheWritePerMillion?.default, `cacheWrite.${ttl}`, 'optional', parts, reasons)
  }
  if (usage.reasoningBilling?.kind === 'separate' || usage.reasoningSeparate !== null) {
    const rate = card.reasoningPerMillion ?? card.outputPerMillion
    priceBucket(usage.reasoningBilling?.tokens ?? usage.reasoningSeparate, rate, 'reasoningSeparate', 'required', parts, reasons)
  }
  if (usage.reasoningBilling?.kind === 'unknown' || (usage.reasoningUnspecified !== null && usage.reasoningUnspecified !== 0)) {
    reasons.push('reasoning contract unspecified; cannot add or omit as a complete total')
  }

  const observed = !unreliableBound && parts.length
    ? decimalFromMillionths(parts.reduce((sum, part) => sum + part, 0n))
    : (!unreliableBound && !parts.length ? null : null)
  const primaryMissing = usage.uncachedInput === null && usage.output === null && usage.cacheReadStatus !== 'known'
    && Object.values(usage.cacheWriteStatus).every(status => status !== 'known')
    && usage.reasoningSeparate === null
    && usage.reasoningOutputSubset === null
    && (usage.reasoningUnspecified === null)

  if (reasons.length && primaryMissing) {
    return { status: 'unknown', totalUsd: null, observedUsd: observed, reasons }
  }
  if (reasons.length) {
    return { status: 'incomplete', totalUsd: null, observedUsd: observed, reasons }
  }
  const total = observed ?? usd('0')
  return { status: 'complete', totalUsd: total, observedUsd: total, reasons: [] }
}

export function apiEquivalentUsd(usage: NormalizedUsage, card: PriceCard | undefined): UsdDecimal | null {
  const priced = priceUsage(usage, card)
  return priced.status === 'complete' ? priced.totalUsd : null
}
