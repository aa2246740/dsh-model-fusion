import { digestOf } from '../digest.js'
import { FusionError, USAGE_MERGE_CONFLICT } from '../errors.js'

export type Count =
  | { state: 'known'; tokens: number }
  | { state: 'unknown' }
  | { state: 'not_applicable' }

export const known = (tokens: number): Count => ({ state: 'known', tokens: safeTokens(tokens) })
export const unknown = (): Count => ({ state: 'unknown' })
export const na = (): Count => ({ state: 'not_applicable' })

export type CacheWrites =
  | { kind: 'not_applicable' }
  | { kind: 'unknown' }
  | { kind: 'aggregate'; tokens: Count; rateKey: string }
  | { kind: 'details'; buckets: Readonly<Record<string, { tokens: Count; rateKey: string }>> }

export interface CanonicalBill {
  uncachedInput: Count
  cacheRead: Count
  output: Count
  cacheWrite: CacheWrites
  reasoning: { kind: 'included' | 'separate' | 'unknown' | 'not_applicable'; tokens: Count }
}

export interface UsageRequestKey {
  provider: string
  model: string
  requestId: string
  attemptId: string
  contractDigest: string
}

export interface UsageObservation {
  id: string
  key: UsageRequestKey
  sequence: number
  mode: 'snapshot' | 'delta' | 'final'
  bill: CanonicalBill
}

export interface UsageLedgerV2 {
  schemaVersion: 2
  key: UsageRequestKey
  observations: readonly UsageObservation[]
}

export interface UsageProjection {
  bill?: CanonicalBill
  authority: 'none' | 'provisional' | 'final'
}

function requireThat(condition: unknown, code: string, message = code): asserts condition {
  if (!condition) throw new FusionError(USAGE_MERGE_CONFLICT, message)
}

function safeTokens(n: number): number {
  requireThat(Number.isSafeInteger(n) && n >= 0, 'INVALID_TOKEN_COUNT')
  return n
}

function same(a: unknown, b: unknown): boolean {
  return digestOf(a) === digestOf(b)
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value as Readonly<T>
}

export function newLedger(key: UsageRequestKey): UsageLedgerV2 {
  requireThat(Object.values(key).every(value => typeof value === 'string' && value.length > 0), 'INVALID_REQUEST_KEY')
  return freezeDeep({ schemaVersion: 2, key: structuredClone(key), observations: [] })
}

function validCount(value: Count): void {
  requireThat(value && ['known', 'unknown', 'not_applicable'].includes(value.state), 'INVALID_COUNT')
  if (value.state === 'known') safeTokens(value.tokens)
}

function validateBill(bill: CanonicalBill): void {
  validCount(bill.uncachedInput)
  validCount(bill.cacheRead)
  validCount(bill.output)
  validCount(bill.reasoning.tokens)
  requireThat(['included', 'separate', 'unknown', 'not_applicable'].includes(bill.reasoning.kind), 'INVALID_REASONING_CONTRACT')
  if (bill.reasoning.kind === 'included' && bill.reasoning.tokens.state === 'known' && bill.output.state === 'known') {
    requireThat(bill.reasoning.tokens.tokens <= bill.output.tokens, 'REASONING_EXCEEDS_OUTPUT')
  }
  if (bill.reasoning.kind === 'not_applicable') {
    requireThat(bill.reasoning.tokens.state === 'not_applicable', 'REASONING_NOT_APPLICABLE_CONFLICT')
  }
  const write = bill.cacheWrite
  requireThat(['aggregate', 'details', 'unknown', 'not_applicable'].includes(write.kind), 'INVALID_CACHE_LAYOUT')
  if (write.kind === 'aggregate') {
    validCount(write.tokens)
    requireThat(write.rateKey.length > 0, 'RATE_KEY_REQUIRED')
  }
  if (write.kind === 'details') {
    requireThat(Object.keys(write.buckets).length > 0, 'EMPTY_CACHE_DETAIL')
    for (const bucket of Object.values(write.buckets)) {
      validCount(bucket.tokens)
      requireThat(bucket.rateKey.length > 0, 'RATE_KEY_REQUIRED')
    }
  }
}

function addCount(first: Count, second: Count): Count {
  if (first.state === 'unknown' || second.state === 'unknown') return unknown()
  if (first.state === 'not_applicable') return second
  if (second.state === 'not_applicable') return first
  return known(first.tokens + second.tokens)
}

function addWrites(first: CacheWrites, second: CacheWrites): CacheWrites {
  if (first.kind === 'unknown' || second.kind === 'unknown') return { kind: 'unknown' }
  if (first.kind === 'not_applicable') return second
  if (second.kind === 'not_applicable') return first
  requireThat(first.kind === second.kind, 'CACHE_LAYOUT_MIX_REQUIRES_EXPLICIT_CONVERSION')
  if (first.kind === 'aggregate' && second.kind === 'aggregate') {
    requireThat(first.rateKey === second.rateKey, 'CACHE_RATE_CONFLICT')
    return { kind: 'aggregate', rateKey: first.rateKey, tokens: addCount(first.tokens, second.tokens) }
  }
  requireThat(first.kind === 'details' && second.kind === 'details', 'CACHE_LAYOUT_CONFLICT')
  const keys = [...new Set([...Object.keys(first.buckets), ...Object.keys(second.buckets)])].sort()
  const buckets = Object.fromEntries(keys.map(key => {
    const left = first.buckets[key]
    const right = second.buckets[key]
    if (!left) return [key, right] as const
    if (!right) return [key, left] as const
    requireThat(left.rateKey === right.rateKey, 'CACHE_RATE_CONFLICT')
    return [key, { rateKey: left.rateKey, tokens: addCount(left.tokens, right.tokens) }] as const
  }))
  return { kind: 'details', buckets }
}

function addBill(first: CanonicalBill, second: CanonicalBill): CanonicalBill {
  requireThat(first.reasoning.kind === second.reasoning.kind, 'DELTA_REASONING_CONTRACT_CONFLICT')
  return {
    uncachedInput: addCount(first.uncachedInput, second.uncachedInput),
    cacheRead: addCount(first.cacheRead, second.cacheRead),
    output: addCount(first.output, second.output),
    cacheWrite: addWrites(first.cacheWrite, second.cacheWrite),
    reasoning: { kind: first.reasoning.kind, tokens: addCount(first.reasoning.tokens, second.reasoning.tokens) },
  }
}

export function projectLedger(ledger: UsageLedgerV2): UsageProjection {
  const finals = ledger.observations.filter(item => item.mode === 'final')
  if (finals.length) {
    for (const item of finals) requireThat(same(item.bill, finals[0]!.bill), 'CONFLICTING_FINAL_BILLS')
    return { authority: 'final', bill: finals[0]!.bill }
  }
  const snapshots = ledger.observations.filter(item => item.mode === 'snapshot').sort((a, b) => a.sequence - b.sequence)
  const base = snapshots.at(-1)
  const deltas = ledger.observations
    .filter(item => item.mode === 'delta' && (!base || item.sequence > base.sequence))
    .sort((a, b) => a.sequence - b.sequence)
  let bill = base?.bill
  for (const delta of deltas) bill = bill ? addBill(bill, delta.bill) : delta.bill
  return { authority: bill ? 'provisional' : 'none', bill }
}

export function ingestObservation(ledger: UsageLedgerV2, observation: UsageObservation): UsageLedgerV2 {
  requireThat(ledger.schemaVersion === 2 && same(ledger.key, observation.key), 'REQUEST_SCOPE_MISMATCH')
  requireThat(observation.id.length > 0 && Number.isSafeInteger(observation.sequence) && observation.sequence >= 0, 'INVALID_OBSERVATION_ID_OR_SEQUENCE')
  requireThat(['snapshot', 'delta', 'final'].includes(observation.mode), 'INVALID_OBSERVATION_MODE')
  validateBill(observation.bill)
  const existing = ledger.observations.find(item => item.id === observation.id)
  if (existing) {
    requireThat(digestOf(existing) === digestOf(observation), 'OBSERVATION_ID_CONFLICT')
    return ledger
  }
  const sameSlot = ledger.observations.find(item => item.sequence === observation.sequence)
  if (sameSlot) {
    requireThat(sameSlot.mode === observation.mode && same(sameSlot.bill, observation.bill), 'OBSERVATION_SEQUENCE_CONFLICT')
    requireThat(observation.mode !== 'delta', 'DELTA_REQUIRES_STABLE_EVENT_ID')
  }
  const next = freezeDeep({
    ...ledger,
    observations: [...ledger.observations, structuredClone(observation)],
  })
  projectLedger(next)
  return next
}

export function ingestDurable(ledger: UsageLedgerV2, observation: UsageObservation): UsageLedgerV2 {
  return ingestObservation(structuredClone(ledger), structuredClone(observation))
}

export function restoreLedger(raw: unknown): UsageLedgerV2 {
  requireThat(raw && typeof raw === 'object', 'INVALID_LEDGER')
  const value = raw as Partial<UsageLedgerV2>
  requireThat(value.schemaVersion === 2 && value.key && Array.isArray(value.observations), 'UNSUPPORTED_LEDGER_FORMAT')
  for (const field of ['provider', 'model', 'requestId', 'attemptId', 'contractDigest'] as const) {
    requireThat(typeof value.key[field] === 'string' && value.key[field].length, 'INVALID_REQUEST_KEY')
  }
  let state = newLedger(structuredClone(value.key as UsageRequestKey))
  for (const item of value.observations ?? []) state = ingestDurable(state, item)
  return state
}

export function splitInput(total: Count, cached: Count, includesCache: boolean | null): Count {
  if (includesCache === false) return total
  if (includesCache === null) {
    if (cached.state === 'not_applicable' || (cached.state === 'known' && cached.tokens === 0)) return total
    return unknown()
  }
  if (total.state !== 'known' || cached.state !== 'known') return unknown()
  requireThat(cached.tokens <= total.tokens, 'CACHE_EXCEEDS_INPUT')
  return known(total.tokens - cached.tokens)
}

export const observationDigest = (observation: UsageObservation): string => digestOf(observation)
