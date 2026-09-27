import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { BindingRepository } from '../src/host/bindings.js'
import { readFusionStatus, taskStage } from '../src/host/status.js'
import { completeProfile } from '../src/profile/resolve.js'
import { loadPromptBundle } from '../src/prompts.js'
import { billFromNativeUsage, type NativeUsageRecord } from '../src/host/native-usage.js'
import { newLedger, ingestDurable } from '../src/usage/ledger.js'
import { created, envelope, TASK, PARENT } from './helpers.js'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fusion-status-')), file = join(root, 'state.sqlite')
  const store = new SqliteFusionStore(file)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => store.close())
  const prompts = loadPromptBundle(), profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
    lead: { provider: 'fixture', model: 'lead' }, worker: { provider: 'fixture', model: 'worker' }, dataPolicyId: 'local' }, prompts)
  store.create(created())
  store.append(TASK, 1, [envelope('profile/frozen', 2, { digest: profile.digest, profileId: profile.id, version: profile.version })])
  const bindings = new BindingRepository(store); bindings.select(PARENT, TASK, { profile, prompts })
  return { store, bindings, file }
}

function usage(id: string, mode: 'final' | 'snapshot' | 'none', tokens = 0): NativeUsageRecord {
  const key = { provider: 'actual-provider', model: 'actual-model', requestId: id, attemptId: id, contractDigest: 'native' }
  let ledger = newLedger(key)
  if (mode !== 'none') {
    ledger = ingestDurable(ledger, { id: `${id}:partial`, key, sequence: 1, mode: 'snapshot', bill: billFromNativeUsage({ inputTokens: 999, outputTokens: 999 }) })
    ledger = ingestDurable(ledger, { id: `${id}:latest`, key, sequence: 2, mode,
      bill: billFromNativeUsage({ inputTokens: tokens, outputTokens: 2, cacheReadTokens: 0 }) })
  }
  return { schemaVersion: 1, taskId: TASK, sessionId: PARENT, role: 'lead', purpose: 'conversation', maxOutputTokens: 8000,
    nativeInvocationId: id, startedAt: `2026-09-22T00:00:${id.padStart(2, '0')}Z`, endedAt: null, nativeStreamInvocations: 1,
    upstreamHttpCalls: null, outcome: 'entered', ledger, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null }
}

describe('read-only Fusion status', () => {
  it('does not expose another session or an inactive binding, or create settings/runtime state', () => {
    const { store, bindings } = setup()
    const write = vi.spyOn(store, 'writeDocument')
    expect(readFusionStatus(store, 'ordinary')).not.toHaveProperty('task')
    expect(write).not.toHaveBeenCalled()
    bindings.clear(PARENT); write.mockClear()
    expect(readFusionStatus(store, PARENT)).toMatchObject({ selected: false })
    expect(readFusionStatus(store, PARENT)).not.toHaveProperty('task')
    expect(write).not.toHaveBeenCalled()
  })

  it('projects authoritative usage without summing partial snapshots, and keeps missing fields unknown', () => {
    const { store } = setup()
    store.writeDocument(`usage:${TASK}:one`, 0, usage('1', 'final', 30))
    store.writeDocument(`usage:${TASK}:two`, 0, usage('2', 'snapshot', 20))
    store.writeDocument(`usage:${TASK}:three`, 0, usage('3', 'none'))
    const task = readFusionStatus(store, PARENT).task!
    expect(task.usage).toMatchObject({ calls: 3, finalCalls: 1, provisionalCalls: 1, unreportedCalls: 1,
      input: { knownTokens: 50, reportedRequests: 2, totalRequests: 3 }, output: { knownTokens: 4, reportedRequests: 2 },
      cacheRead: { knownTokens: 0, reportedRequests: 2 }, actualBilledUsd: null, upstreamHttpCalls: null })
    expect(task.requests[0]).toMatchObject({ provider: 'actual-provider', model: 'actual-model', authority: 'none' })
  })

  it('splits usage by role so the Lead share of spend is visible', () => {
    const { store } = setup()
    store.writeDocument(`usage:${TASK}:lead`, 0, usage('1', 'final', 30))
    store.writeDocument(`usage:${TASK}:worker`, 0, { ...usage('2', 'final', 70), role: 'worker' })
    const { usage: totals, automatedChecks } = readFusionStatus(store, PARENT).task!
    expect(totals.byRole.lead).toMatchObject({ calls: 1, input: { knownTokens: 30 }, output: { knownTokens: 2 } })
    expect(totals.byRole.worker).toMatchObject({ calls: 1, input: { knownTokens: 70 }, output: { knownTokens: 2 } })
    expect(automatedChecks).toBeNull()
  })

  it('never labels gated work complete, even if its business phase is completed', () => {
    const { store } = setup(), state = { ...store.load(TASK)!, phase: 'COMPLETED' as const }
    expect(taskStage({ ...state, control: { ...state.control, mode: 'paused' } }, false).stage).toBe('已暂停')
    expect(taskStage({ ...state, control: { ...state.control, budgetBlocked: true } }, false).stage).toBe('等待额度')
    expect(taskStage({ ...state, control: { ...state.control, pendingApprovalIds: ['one'] } }, false).stage).toBe('等待确认')
    expect(taskStage({ ...state, control: { ...state.control, recovering: true } }, false).stage).toBe('等待检查')
    expect(taskStage(state, false).stage).toBe('等待检查')
    expect(taskStage({ ...state, control: { ...state.control, mode: 'completed' } }, false).stage).toBe('完成')
  })

  it('shows in-progress frozen validation and excludes private arguments, prompts and raw evidence', () => {
    const { store } = setup()
    store.writeDocument(`native-effect:${TASK}:one`, 0, { schemaVersion: 1, taskId: TASK, role: 'worker',
      toolName: 'bash', state: 'dispatch-started', startedAt: '2026-09-22T00:00:00Z', arguments: { secret: 'PRIVATE_ARGUMENT' } })
    store.writeDocument(`check-invocation:${TASK}:one`, 0, { evidence: { taskId: TASK, state: 'started' }, check: 'PRIVATE_CHECK' })
    const value = readFusionStatus(store, PARENT)
    expect(value.task).toMatchObject({ stage: '验证', unsettledTools: 1, tools: [{ name: 'bash', state: 'dispatch-started' }] })
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_ARGUMENT|PRIVATE_CHECK|prompts|observations|arguments/)
  })

  it('does not let an exhausted Worker hint conceal approval, budget, recovery or validation state', () => {
    const { store } = setup(), state = { ...store.load(TASK)!, phase: 'WORKER_RUNNING' as const }
    expect(taskStage(state, false, true)).toMatchObject({ stage: '等待反馈', attention: true })
    expect(taskStage({ ...state, control: { ...state.control, pendingApprovalIds: ['one'] } }, false, true).stage).toBe('等待确认')
    expect(taskStage({ ...state, control: { ...state.control, budgetBlocked: true } }, false, true).stage).toBe('等待额度')
    expect(taskStage({ ...state, control: { ...state.control, recovering: true } }, false, true).stage).toBe('等待检查')
    expect(taskStage(state, true, true).stage).toBe('验证')
    expect(taskStage({ ...state, phase: 'DIRECT' }, false, true).stage).toBe('执行')
  })

  it('keeps aggregate counts across a bounded tail and survives reopening without writes', () => {
    const { store, file } = setup()
    for (let i = 1; i <= 20; i++) store.writeDocument(`usage:${TASK}:${i}`, 0, usage(String(i), 'final', 1))
    const before = store.listDocumentIds('').map(id => [id, store.readDocument(id)])
    const reopened = new SqliteFusionStore(file); cleanup.push(() => reopened.close())
    for (let i = 0; i < 10; i++) {
      const task = readFusionStatus(reopened, PARENT).task!
      expect(task.usage.calls).toBe(20); expect(task.usage.input.knownTokens).toBe(20)
      expect(task.requests).toHaveLength(12)
      expect(task.requests[0]!.startedAt).toContain(':20Z')
    }
    expect(store.listDocumentIds('').map(id => [id, store.readDocument(id)])).toEqual(before)
  })

  it('shows an upstream quota stop without masking recovery, approval, validation or completion', () => {
    const { store } = setup(), state = { ...store.load(TASK)!, phase: 'WORKER_RUNNING' as const }
    expect(taskStage(state, false, false, true)).toMatchObject({ stage: '等待额度', attention: true })
    expect(taskStage({ ...state, control: { ...state.control, recovering: true } }, false, false, true).stage).toBe('等待检查')
    expect(taskStage({ ...state, control: { ...state.control, pendingApprovalIds: ['one'] } }, false, false, true).stage).toBe('等待确认')
    expect(taskStage(state, true, false, true).stage).toBe('验证')
    expect(taskStage({ ...state, phase: 'COMPLETED', control: { ...state.control, mode: 'completed' } }, false, false, true).stage).toBe('完成')
  })

  it('rejects foreign usage and corrupt ledgers instead of reporting plausible totals', () => {
    const { store } = setup(), id = `usage:${TASK}:bad`
    store.writeDocument(id, 0, { ...usage('1', 'none'), taskId: 'foreign' })
    expect(() => readFusionStatus(store, PARENT)).toThrow('状态记录')
    store.writeDocument(id, 1, { ...usage('1', 'none'), ledger: { schemaVersion: 0 } })
    expect(() => readFusionStatus(store, PARENT)).toThrow('UNSUPPORTED_LEDGER_FORMAT')
  })
})

import { backfillHistory, readHistory, usageSummary } from '../src/host/history.js'

describe('history projection', () => {
  it('backfills once, uses actual routes, preserves unknowns, and never loads full task snapshots on GET', () => {
    const { store } = setup()
    store.writeDocument(`usage:${TASK}:one`, 0, usage('1', 'final', 30))
    store.writeDocument(`usage:${TASK}:two`, 0, { ...usage('2', 'snapshot', 20), role: 'worker', purpose: 'compaction' })
    store.writeDocument(`usage:${TASK}:three`, 0, usage('3', 'none'))
    backfillHistory(store)
    const load = vi.spyOn(store, 'load'), write = vi.spyOn(store, 'writeDocument')
    const result = readHistory(store)
    expect(result.totals).toMatchObject({ calls: 3, final: 1, provisional: 1, unreported: 1, input: { known: 50, reported: 2 } })
    expect(result.groups).toHaveLength(2)
    expect(result.groups[0]).toMatchObject({ provider: 'actual-provider', model: 'actual-model' })
    expect(result.savingsPercent).toBeNull()
    expect(result.actualBilledUsd).toBeNull()
    expect(load).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    backfillHistory(store)
    expect(load).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    expect(readHistory(store).totals).toEqual(result.totals)
  })

  it('replaces an invocation summary instead of double counting and rolls back a conflicting batch', () => {
    const { store } = setup(), id = `usage-index:${TASK}:one`
    store.writeDocument(id, 0, usageSummary(usage('1', 'snapshot', 25)))
    expect(readHistory(store).totals.input.known).toBe(25)
    store.writeDocument(id, 1, usageSummary(usage('1', 'final', 30)))
    expect(readHistory(store).totals).toMatchObject({ calls: 1, final: 1, input: { known: 30, reported: 1 } })
    expect(() => store.writeDocuments([{ id: 'new-index', expectedRevision: 0, value: {} },
      { id, expectedRevision: 0, value: {} }])).toThrow()
    expect(store.readDocument('new-index')).toBeUndefined()
    expect(readHistory(store).totals.calls).toBe(1)
  })
})
