import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { FusionRecovery } from '../src/client/FusionRecovery.js'
import type { FusionStatus } from '../src/status.js'

function task(over: { recovering?: boolean; outcomeUnknown?: boolean } = {}): NonNullable<FusionStatus['task']> {
  return {
    id: 'task-1', revision: 1, stage: '等待检查', detail: null, attention: true, verification: 'unverified',
    workerId: 'worker-1', models: { lead: { provider: 'p', model: 'lead' }, worker: { provider: 'p', model: 'old-worker' }, compactor: null },
    usage: { calls: 0, finalCalls: 0, provisionalCalls: 0, unreportedCalls: 0, compactionCalls: 0, keepaliveCalls: 0,
      input: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 },
      cacheRead: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 },
      output: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 },
      actualBilledUsd: null, upstreamHttpCalls: null,
      byRole: { lead: { calls: 0, input: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 }, cacheRead: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 }, output: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 } },
        worker: { calls: 0, input: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 }, cacheRead: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 }, output: { knownTokens: 0, reportedRequests: 0, totalRequests: 0 } } } },
    automatedChecks: null, requests: [], tools: [], contexts: [], pendingApprovals: 0, unsettledTools: 0,
    recovering: false, outcomeUnknown: false,
    modelControl: { schemaVersion: 1, revision: 3, sessionId: 's', profileDigest: 'd', epoch: 0,
      routes: { lead: { provider: 'p', model: 'lead' }, worker: { provider: 'p', model: 'old-worker' } },
      waits: { worker: { taskId: 'task-1', code: 'RATE_LIMIT', at: '2026-10-08T16:47:05.000Z', quotaResetAt: null } } },
    ...over,
  }
}

function render(value: NonNullable<FusionStatus['task']>) {
  let root!: ReturnType<typeof create>
  act(() => { root = create(React.createElement(FusionRecovery, { sessionId: 's', task: value })) })
  return root
}

describe('Fusion recovery panel', () => {
  it('shows the inspection gate and disables continue while recovering', () => {
    const root = render(task({ recovering: true }))
    const text = JSON.stringify(root.toJSON())
    expect(text).toContain('/fusion recover')
    expect(text).toContain('does not change the model')
    expect(text).toContain('does not rewrite this conversation')
    expect(text).toContain('"type":"fieldset","props":{"disabled":true}')
    root.unmount()
  })

  it('leaves continue available when the task is not recovering', () => {
    const root = render(task())
    const text = JSON.stringify(root.toJSON())
    expect(text).not.toContain('does not change the model')
    expect(text).toContain('RATE_LIMIT')
    expect(text).toContain('"type":"fieldset","props":{"disabled":false}')
    root.unmount()
  })
})
