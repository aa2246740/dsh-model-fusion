import type { PairProfile } from '../contracts.js'

/** No provider-name heuristic can establish cache support for a DSH route. */
export function keepaliveChoice(value: unknown): PairProfile['cacheKeepalive'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache keepalive selection')
  const raw = value as Record<string, unknown>
  const valid = (item: unknown): item is boolean | 'auto' => typeof item === 'boolean' || item === 'auto'
  if (Object.keys(raw).some(key => key !== 'lead' && key !== 'worker') || !valid(raw.lead) || !valid(raw.worker)) {
    throw new Error('Cache keepalive requires explicit Lead and Worker choices (true, false or "auto")')
  }
  return { lead: raw.lead, worker: raw.worker }
}
