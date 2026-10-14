import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { FusionStatus } from '../src/client/FusionStatus.js'
vi.mock('../src/client/FusionRecovery.js', () => ({ FusionRecovery: () => null }))
const subtotal = { totalRequests: 0, reportedRequests: 0, knownTokens: 0 }
const role = { calls: 0, input: subtotal, output: subtotal, cacheRead: subtotal }
const status = { schemaVersion: 1, sessionId: 's', selected: true, task: { id: 't', attention: false, stage: '执行', verification: 'unverified',
  usage: { calls: 0, byRole: { lead: role, worker: role }, input: subtotal, output: subtotal, cacheRead: subtotal },
  models: { lead: { model: 'x' }, worker: { model: 'x' } }, requests: [], tools: [], contexts: [] } }
let roots: ReactTestRenderer[] = []
function setup(delay = 0) {
  vi.useFakeTimers(); const doc = new EventTarget(); Object.assign(doc, { visibilityState: 'visible' }); vi.stubGlobal('document', doc)
  const fetch = vi.fn(async (_url: unknown, { signal }: { signal: AbortSignal }) => {
    if (delay) await new Promise((resolve, reject) => { setTimeout(resolve, delay); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }) })
    return { ok: true, json: async () => status }
  }); vi.stubGlobal('fetch', fetch); return { doc, fetch }
}
async function mount(attentionOnly = true, sessionId = 's') {
  let root!: ReactTestRenderer
  await act(async () => { root = create(React.createElement(FusionStatus, { sessionId, attentionOnly })) }); roots.push(root); return root
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
afterEach(async () => { await act(async () => { roots.forEach(r => r.unmount()) }); roots = []; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('shared status subscriptions', () => {
  it('backs off when attentionOnly renders null, stops when hidden/unmounted and refreshes when visible', async () => {
    const { doc, fetch } = setup(), root = await mount(); expect(root.toJSON()).toBeNull()
    await tick(6000); expect(fetch).toHaveBeenCalledTimes(1)
    await tick(9000); expect(fetch).toHaveBeenCalledTimes(2)
    Object.assign(doc, { visibilityState: 'hidden' }); await act(async () => { doc.dispatchEvent(new Event('visibilitychange')) })
    await tick(60000); expect(fetch).toHaveBeenCalledTimes(2)
    Object.assign(doc, { visibilityState: 'visible' }); await act(async () => { doc.dispatchEvent(new Event('visibilitychange')) })
    expect(fetch).toHaveBeenCalledTimes(3)
    await act(async () => root.unmount()); await tick(60000); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('reveals a new attention state on the next 15-second poll while visible', async () => {
    const { fetch } = setup(); let attention = false
    fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ ...status, task: { ...status.task, attention } }) }))
    const root = await mount(); expect(root.toJSON()).toBeNull()
    attention = true
    await tick(14999); expect(root.toJSON()).toBeNull()
    await tick(1); expect(root.toJSON()).not.toBeNull(); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('keeps collapsed details slow and refreshes an expanded active view without losing its snapshot', async () => {
    const { fetch } = setup(), root = await mount(false)
    expect(root.root.findByType('details').props.open).toBeUndefined()
    await tick(4000); expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => { root.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
    expect(fetch).toHaveBeenCalledTimes(2); expect(root.root.findByType('details')).toBeDefined()
    await tick(4000); expect(fetch).toHaveBeenCalledTimes(4)
    await act(async () => { root.root.findByType('details').props.onToggle({ currentTarget: { open: false } }) })
    await tick(2000); const afterPending = fetch.mock.calls.length
    await tick(14000); expect(fetch).toHaveBeenCalledTimes(afterPending)
  })
  it('deduplicates multiple instances and keeps the subscription until the last unmount', async () => {
    const { fetch } = setup(); const first = await mount(); await mount()
    expect(fetch).toHaveBeenCalledTimes(1); await tick(15000); expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => first.unmount()); await tick(15000); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('waits for completion plus the interval and shares in-flight reads', async () => {
    const { fetch } = setup(3000); await mount(); await mount()
    await tick(17999); expect(fetch).toHaveBeenCalledTimes(1)
    await tick(1); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('does not let an aborted old subscription overwrite a remounted session', async () => {
    const { fetch } = setup(); let release!: () => void
    fetch.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return { ok: true, json: async () => ({ ...status, sessionId: 'wrong' }) } })
    const first = await mount(); await act(async () => first.unmount()); await mount()
    await act(async () => release()); await tick(15000); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('backs off completed tasks even when details are expanded', async () => {
    const { fetch } = setup(); fetch.mockResolvedValue({ ok: true, json: async () => ({ ...status, task: { ...status.task, stage: '完成' } }) })
    const root = await mount(false)
    await act(async () => { root.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
    await tick(14000); expect(fetch).toHaveBeenCalledTimes(2)
    await tick(1000); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('stops fast polling when an expanded attention hint becomes invisible', async () => {
    const { fetch } = setup(); let attention = true
    fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ ...status, task: { ...status.task, attention } }) }))
    const root = await mount()
    await act(async () => { root.root.findByType('details').props.onToggle({ currentTarget: { open: true } }) })
    attention = false; await tick(2000); expect(root.toJSON()).toBeNull()
    const calls = fetch.mock.calls.length; await tick(14000); expect(fetch).toHaveBeenCalledTimes(calls)
  })

})
