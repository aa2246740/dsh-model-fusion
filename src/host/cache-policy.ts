import type { Role } from '../contracts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { cacheDefaults, type CacheDefaults, type CacheMode } from './cache-defaults.js'

/** The user's choice for one physical model route; absent fields fall back to learned/default values. */
export interface ModelCacheSetting { mode?: CacheMode; intervalSeconds?: number }

/** One model request that followed a wait: the evidence the policy learns from and the settings page shows. */
export interface CacheSample { at: string; gapSeconds: number; ping: boolean; hit: boolean; cacheRead: number; input: number; output?: number }

export interface ModelCacheStats {
  schemaVersion: 1
  provider: string
  model: string
  samples: CacheSample[]
  totals: {
    /** Real requests after a wait of at least WAIT_SECONDS, and how many still found their prefix cached. */
    waits: number; waitHits: number
    /** Keepalive pings and the tokens they read (mostly at the cache price). */
    pings: number; pingHits: number; pingTokens: number
    /** Output tokens of pings; absent on stats recorded before 0.2.3. A route that ignores the output cap shows here. */
    pingOutputTokens?: number
    /** Prefix tokens served from cache after a wait, and tokens resent uncached after a wait. */
    keptWarmTokens: number; resentTokens: number
  }
  /** Interval shortened after pings kept missing (never lengthened automatically). */
  learnedIntervalSeconds?: number
  /** Rule that produced learnedIntervalSeconds; values from older rules are ignored. */
  learnedRule?: number
  updatedAt: string
}

export interface EffectiveCachePolicy {
  mode: CacheMode
  intervalSeconds: number
  modeSource: 'user' | 'pair' | 'role' | CacheDefaults['source']
  intervalSource: 'user' | 'learned' | CacheDefaults['source']
  defaults: CacheDefaults
}

/** A request counts as a wait when this long passed since the previous request of the same agent. */
export const WAIT_SECONDS = 120
/**
 * Rule 2 (0.2.3): shorten only when most recent pings at this interval missed (3 of the last up to 5).
 * Rule 1 shortened on 2 misses, and providers also drop single prefixes at random: the live log had
 * 4 partial misses in 123 pings, each keeping only the shared 3,968-token system+tools head, while
 * a probe of the same route still hit after 10+ idle minutes. That noise cut a 285 s interval to 214 s.
 */
export const LEARNING_RULE = 2
const SAMPLE_LIMIT = 60
const MIN_INTERVAL = 60, MAX_INTERVAL = 3_540

/** A request reused its prefix when most of its input came from the cache. */
export const cacheHit = (cacheRead: number, input: number) => cacheRead > 0 && cacheRead / (cacheRead + input) >= 0.5

const key = (provider: string, model: string) => `${provider}\u0001${model}`
export const clampInterval = (seconds: number) => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(seconds)))

export class CachePolicy {
  constructor(readonly store: SqliteFusionStore) {}

  setting(provider: string, model: string): ModelCacheSetting | undefined {
    return this.store.readDocument(`cache-setting:${key(provider, model)}`)?.value as ModelCacheSetting | undefined
  }

  /** Save or clear (null) the user's choice; invalid values are refused, not coerced. */
  save(provider: string, model: string, setting: ModelCacheSetting | null): void {
    const id = `cache-setting:${key(provider, model)}`, prior = this.store.readDocument(id)
    if (setting === null) { if (prior) this.store.writeDocument(id, prior.revision, {}); return }
    if (setting.mode !== undefined && !['auto', 'on', 'off'].includes(setting.mode)) throw new Error('Keepalive mode must be auto, on or off')
    if (setting.intervalSeconds !== undefined && (!Number.isFinite(setting.intervalSeconds)
      || setting.intervalSeconds < MIN_INTERVAL || setting.intervalSeconds > MAX_INTERVAL)) {
      throw new Error(`Keepalive interval must be ${MIN_INTERVAL}–${MAX_INTERVAL} seconds`)
    }
    this.store.writeDocument(id, prior?.revision ?? 0, { ...(setting.mode ? { mode: setting.mode } : {}),
      ...(setting.intervalSeconds ? { intervalSeconds: Math.round(setting.intervalSeconds) } : {}) })
  }

  stats(provider: string, model: string): ModelCacheStats | undefined {
    return this.store.readDocument(`cache-stats:${key(provider, model)}`)?.value as ModelCacheStats | undefined
  }

  /**
   * Record a request that followed a wait (or any keepalive ping). Pings that keep missing at the current
   * interval shorten it by a quarter: a too-long interval wastes every ping, a too-short one only costs extra
   * cheap reads, so the rule only ever moves toward safety. Lengthening is left to the user (see suggestion).
   */
  observe(provider: string, model: string, sample: Omit<CacheSample, 'at'>, currentIntervalSeconds: number): void {
    if (!sample.ping && sample.gapSeconds < WAIT_SECONDS) return
    const id = `cache-stats:${key(provider, model)}`, prior = this.store.readDocument(id)
    const stats: ModelCacheStats = (prior?.value as ModelCacheStats | undefined) ?? { schemaVersion: 1, provider, model, samples: [],
      totals: { waits: 0, waitHits: 0, pings: 0, pingHits: 0, pingTokens: 0, keptWarmTokens: 0, resentTokens: 0 }, updatedAt: '' }
    const row: CacheSample = { at: new Date().toISOString(), ...sample }
    stats.samples = [...stats.samples, row].slice(-SAMPLE_LIMIT)
    const totals = stats.totals
    if (row.ping) {
      totals.pings++; totals.pingTokens += row.cacheRead + row.input
      totals.pingOutputTokens = (totals.pingOutputTokens ?? 0) + (row.output ?? 0)
      if (row.hit) totals.pingHits++
      const recent = stats.samples.filter(item => item.ping && Math.abs(item.gapSeconds - currentIntervalSeconds) <= currentIntervalSeconds * 0.25).slice(-5)
      if (recent.filter(item => !item.hit).length >= 3) {
        stats.learnedIntervalSeconds = clampInterval(currentIntervalSeconds * 0.75); stats.learnedRule = LEARNING_RULE
        stats.samples = stats.samples.filter(item => !item.ping) // judge the new interval on fresh pings
      }
    } else {
      totals.waits++
      if (row.hit) { totals.waitHits++; totals.keptWarmTokens += row.cacheRead } else totals.resentTokens += row.input
    }
    stats.updatedAt = row.at
    this.store.writeDocument(id, prior?.revision ?? 0, stats)
  }

  /**
   * User setting > pair profile (older explicit choice) > learned interval > our own route's billing default >
   * model family default > generic. The Worker defaults to off: it rarely waits long enough to need pings.
   */
  resolve(provider: string, model: string, role: Role, pairChoice?: boolean | 'auto'): EffectiveCachePolicy {
    const defaults = cacheDefaults(provider, model)
    const user = this.setting(provider, model) ?? {}
    const stats = this.stats(provider, model)
    const learned = stats?.learnedRule === LEARNING_RULE ? stats.learnedIntervalSeconds : undefined
    let mode: CacheMode, modeSource: EffectiveCachePolicy['modeSource']
    if (user.mode) { mode = user.mode; modeSource = 'user' }
    else if (typeof pairChoice === 'boolean') { mode = pairChoice ? 'on' : 'off'; modeSource = 'pair' }
    else if (role === 'worker') { mode = 'off'; modeSource = 'role' }
    else { mode = defaults.keepalive; modeSource = defaults.source }
    const intervalSeconds = user.intervalSeconds ?? learned ?? defaults.intervalSeconds
    const intervalSource: EffectiveCachePolicy['intervalSource'] = user.intervalSeconds ? 'user' : learned ? 'learned' : defaults.source
    return { mode, intervalSeconds, modeSource, intervalSource, defaults }
  }

  /** Suggest a longer interval only on repeated evidence: real waits that still hit well beyond the interval. */
  suggestion(provider: string, model: string, intervalSeconds: number): number | undefined {
    const long = (this.stats(provider, model)?.samples ?? []).filter(item => !item.ping && item.hit && item.gapSeconds >= intervalSeconds * 1.5)
    if (long.length < 3) return undefined
    return clampInterval(Math.floor(Math.min(...long.map(item => item.gapSeconds)) / 30) * 30)
  }

  /** Every route the plugin has evidence or a setting for, plus the given routes (the configured pair). */
  routes(extra: readonly { provider: string; model: string }[] = []): { provider: string; model: string }[] {
    const ids = [...this.store.listDocumentIds('cache-stats:'), ...this.store.listDocumentIds('cache-setting:')]
      .map(id => id.slice(id.indexOf(':') + 1).split('\u0001') as [string, string])
    const all = [...extra.map(item => [item.provider, item.model] as [string, string]), ...ids]
    const seen = new Set<string>()
    return all.filter(([provider, model]) => provider && model && !seen.has(key(provider, model)) && seen.add(key(provider, model)))
      .map(([provider, model]) => ({ provider, model }))
  }
}

type Route = { provider: string; model: string }
/** One row of the settings page: what applies, why, what the defaults say, and what was observed. */
export function cacheView(policy: CachePolicy, pair?: { lead: Route; worker: Route }, pairChoice?: { lead?: boolean | 'auto'; worker?: boolean | 'auto' }) {
  const same = (a: Route | undefined, provider: string, model: string) => a?.provider === provider && a.model === model
  return policy.routes(pair ? [pair.lead, pair.worker] : []).map(({ provider, model }) => {
    const role: Role | undefined = same(pair?.lead, provider, model) ? 'lead' : same(pair?.worker, provider, model) ? 'worker' : undefined
    const effective = policy.resolve(provider, model, role ?? 'lead', role ? pairChoice?.[role] : undefined)
    const stats = policy.stats(provider, model), { family, route } = effective.defaults
    return { provider, model, role,
      mode: effective.mode, intervalSeconds: effective.intervalSeconds, modeSource: effective.modeSource, intervalSource: effective.intervalSource,
      setting: policy.setting(provider, model) ?? {},
      defaults: { mode: effective.defaults.keepalive, intervalSeconds: effective.defaults.intervalSeconds, source: effective.defaults.source,
        ...(family ? { family: { label: family.label, lifetime: family.lifetime, discount: family.discount, docs: family.docs } } : {}),
        ...(route ? { route: { label: route.label, reason: route.reason } } : {}) },
      totals: stats?.totals ?? null, learnedIntervalSeconds: stats?.learnedRule === LEARNING_RULE ? stats.learnedIntervalSeconds ?? null : null,
      suggestion: policy.suggestion(provider, model, effective.intervalSeconds) ?? null,
      recent: (stats?.samples ?? []).slice(-8).map(item => ({ gapSeconds: Math.round(item.gapSeconds), ping: item.ping, hit: item.hit })) }
  })
}
