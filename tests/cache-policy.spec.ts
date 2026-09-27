import { afterEach, describe, expect, it } from 'vitest'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { cacheDefaults } from '../src/host/cache-defaults.js'
import { CachePolicy, cacheHit, cacheView } from '../src/host/cache-policy.js'

const stores: SqliteFusionStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const policy = () => { const store = new SqliteFusionStore(':memory:'); stores.push(store); return new CachePolicy(store) }
const ping = (hit: boolean, gapSeconds = 285) => ({ gapSeconds, ping: true, hit, cacheRead: hit ? 40_000 : 0, input: hit ? 20 : 40_000 })

describe('documented cache defaults', () => {
  it('matches the model id, not the route name, and knows our own routes billing', () => {
    expect(cacheDefaults('any-route', 'gpt-6-astra')).toMatchObject({ keepalive: 'auto', intervalSeconds: 285, source: 'family', family: { id: 'openai' } })
    expect(cacheDefaults('bedrock-eu', 'claude-opus-5-5')).toMatchObject({ keepalive: 'auto', intervalSeconds: 270, family: { id: 'anthropic' } })
    expect(cacheDefaults('ds', 'deepseek-v4-pro')).toMatchObject({ keepalive: 'off', family: { id: 'deepseek' } })
    expect(cacheDefaults('pi-zai-coding-cn', 'glm-5.3')).toMatchObject({ keepalive: 'off', source: 'route', family: { id: 'zhipu' } })
    expect(cacheDefaults('pi-openai-codex', 'gpt-6-astra')).toMatchObject({ keepalive: 'auto', source: 'route' })
    expect(cacheDefaults('my-gateway', 'house-model')).toEqual({ keepalive: 'auto', intervalSeconds: 285, source: 'generic' })
  })
})

describe('per-model cache policy', () => {
  it('resolves user > older pair choice > role > documented default, per field', () => {
    const cache = policy()
    expect(cache.resolve('r', 'gpt-6-astra', 'lead')).toMatchObject({ mode: 'auto', intervalSeconds: 285, modeSource: 'family', intervalSource: 'family' })
    expect(cache.resolve('r', 'gpt-6-astra', 'worker')).toMatchObject({ mode: 'off', modeSource: 'role' })
    expect(cache.resolve('r', 'gpt-6-astra', 'lead', false)).toMatchObject({ mode: 'off', modeSource: 'pair' })
    cache.save('r', 'gpt-6-astra', { mode: 'on', intervalSeconds: 600 })
    expect(cache.resolve('r', 'gpt-6-astra', 'worker', false)).toMatchObject({ mode: 'on', intervalSeconds: 600, modeSource: 'user', intervalSource: 'user' })
    cache.save('r', 'gpt-6-astra', null)
    expect(cache.resolve('r', 'gpt-6-astra', 'lead')).toMatchObject({ mode: 'auto', intervalSeconds: 285 })
    expect(() => cache.save('r', 'm', { mode: 'sometimes' as never })).toThrow()
    expect(() => cache.save('r', 'm', { intervalSeconds: 10 })).toThrow()
  })

  it('counts waits and pings, and only records requests that followed a wait', () => {
    const cache = policy()
    cache.observe('r', 'glm-5.3', { gapSeconds: 5, ping: false, hit: true, cacheRead: 9_000, input: 100 }, 285)
    expect(cache.stats('r', 'glm-5.3')).toBeUndefined()
    cache.observe('r', 'glm-5.3', { gapSeconds: 700, ping: false, hit: false, cacheRead: 3_000, input: 17_000 }, 285)
    cache.observe('r', 'glm-5.3', { gapSeconds: 290, ping: false, hit: true, cacheRead: 30_000, input: 900 }, 285)
    cache.observe('r', 'glm-5.3', ping(true), 285)
    expect(cache.stats('r', 'glm-5.3')!.totals).toEqual({ waits: 2, waitHits: 1, pings: 1, pingHits: 1, pingTokens: 40_020, keptWarmTokens: 30_000, resentTokens: 17_000 })
    expect(cacheHit(3_968, 17_156)).toBe(false)
    expect(cacheHit(28_800, 4_192)).toBe(true)
  })

  it('shortens an interval whose pings keep missing, and never lengthens it by itself', () => {
    const cache = policy()
    for (const hit of [true, false, false]) cache.observe('r', 'grok-4.6', ping(hit), 285)
    expect(cache.stats('r', 'grok-4.6')!.learnedIntervalSeconds).toBe(214)
    expect(cache.resolve('r', 'grok-4.6', 'lead')).toMatchObject({ intervalSeconds: 214, intervalSource: 'learned' })
    for (let i = 0; i < 5; i++) cache.observe('r', 'grok-4.6', { gapSeconds: 900, ping: false, hit: true, cacheRead: 50_000, input: 500 }, 214)
    expect(cache.resolve('r', 'grok-4.6', 'lead').intervalSeconds).toBe(214)
    expect(cache.suggestion('r', 'grok-4.6', 214)).toBe(900)
    cache.save('r', 'grok-4.6', { intervalSeconds: 900 })
    expect(cache.resolve('r', 'grok-4.6', 'lead')).toMatchObject({ intervalSeconds: 900, intervalSource: 'user' })
  })

  it('lists the configured pair and every model with evidence or a setting for the settings page', () => {
    const cache = policy()
    cache.observe('pi-openai-codex', 'gpt-6-astra', ping(true), 285)
    cache.save('other', 'kimi-k3', { mode: 'off' })
    const rows = cacheView(cache, { lead: { provider: 'pi-openai-codex', model: 'gpt-6-astra' }, worker: { provider: 'pi-zai-coding-cn', model: 'glm-5.3-flash' } })
    expect(rows.map(row => [row.model, row.role, row.mode])).toEqual([['gpt-6-astra', 'lead', 'auto'], ['glm-5.3-flash', 'worker', 'off'], ['kimi-k3', undefined, 'off']])
    expect(rows[0]).toMatchObject({ defaults: { family: { label: 'OpenAI' }, route: { label: 'ChatGPT (Codex)' } }, totals: { pings: 1 } })
  })
})
