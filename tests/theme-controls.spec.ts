import React from 'react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { FusionSettings } from '../src/client/FusionSettings.js'
import { FusionStatus } from '../src/client/FusionStatus.js'

const roots: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()) })
  vi.unstubAllGlobals()
})

function styleText(root: ReactTestRenderer): string {
  const styles = root.root.findAllByType('style')
  return styles.map(node => String(node.children.join(''))).join('\n')
}

describe('client theme tokens', () => {
  it('paints the model list with host surface and label tokens in both themes', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })))
    let root!: ReactTestRenderer
    await act(async () => { root = create(React.createElement(FusionSettings)) })
    roots.push(root)
    const css = styleText(root)
    expect(css).not.toContain('--dsw-alias-bg-page-primary')
    expect(css).toContain('.fusion-settings :is(select,option,optgroup){background-color:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)')
    expect(css).not.toMatch(/\.fusion-settings select\{[^}]*color:inherit/)
  })

  it('uses the same tokens for recovery selects', async () => {
    const doc = new EventTarget()
    Object.assign(doc, { visibilityState: 'visible', addEventListener: doc.addEventListener.bind(doc), removeEventListener: doc.removeEventListener.bind(doc) })
    vi.stubGlobal('document', doc)
    const subtotal = { totalRequests: 0, reportedRequests: 0, knownTokens: 0 }
    const role = { calls: 0, input: subtotal, output: subtotal, cacheRead: subtotal }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
      schemaVersion: 1, sessionId: 's', selected: true, observedAt: '2026-10-26T00:00:00.000Z',
      task: { id: 't', revision: 1, attention: false, stage: '已暂停', detail: null, verification: 'unverified',
        usage: { calls: 0, finalCalls: 0, provisionalCalls: 0, unreportedCalls: 0, compactionCalls: 0, keepaliveCalls: 0,
          actualBilledUsd: null, upstreamHttpCalls: null, byRole: { lead: role, worker: role }, input: subtotal, output: subtotal, cacheRead: subtotal },
        models: { lead: { provider: 'p', model: 'm' }, worker: { provider: 'p', model: 'm' }, compactor: null },
        requests: [], tools: [], contexts: [], unsettledTools: 0, pendingApprovals: 0, automatedChecks: 0, workerId: null },
    }) })))
    let root!: ReactTestRenderer
    await act(async () => { root = create(React.createElement(FusionStatus, { sessionId: 's' })) })
    roots.push(root)
    const css = styleText(root)
    expect(css).not.toContain('--dsw-alias-bg-page-primary')
    expect(css).toContain('.fusion-recovery :is(select,input,option,optgroup){background-color:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)')
  })
})
