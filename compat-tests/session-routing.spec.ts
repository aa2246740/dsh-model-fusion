import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Basic from '@deepseek-ai/dsh-compaction-basic'
import { LlmAdapter, createUserMessage, ReasoningEffortId, errorChain } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Controller } from '@fusion-compat/controller'
import { CompactionRouteRegistry } from '@fusion-compat/routes'
import { installModelSelectionProjection } from '@fusion-compat/model-selection'
import { installCompactionRouting } from '../src/host/compaction-routing.js'
import { NativeContextGuard } from '../src/host/native-context.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { BindingRepository } from '../src/host/bindings.js'
import { completeProfile } from '../src/profile/resolve.js'
import { readModelControl } from '../src/host/native-model-control.js'
import { TaskId } from '../src/contracts.js'
import { FusionCatalogAdapter } from '../src/host/native-selection.js'

const cleanups: (() => Promise<void>)[] = []
const supplementalResults: unknown[] = []
let networkAttempts = 0
let restoreNetwork: (() => void)[] = []
beforeAll(() => {
  const deny = () => { networkAttempts++; throw new Error('Supplemental test forbids network') }
  const socket = vi.spyOn(Socket.prototype, 'connect').mockImplementation(deny)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(deny)
  restoreNetwork = [() => socket.mockRestore(), () => fetch.mockRestore()]
})
afterAll(() => {
  restoreNetwork.forEach(fn => fn())
  if (process.env.V9_EVIDENCE_PATH) writeFileSync(process.env.V9_EVIDENCE_PATH, JSON.stringify({
    networkPolicy: 'Deny fetch and Socket.connect during all test cases; only synthetic physical adapter registered',
    networkAttempts, supplementalResults,
  }, null, 2))
  expect(networkAttempts).toBe(0)
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { distinctCompactors?: boolean; workerOwner?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fusion-saviour-compat-'))
  const store = new SqliteFusionStore(join(root, 'fixture.sqlite')), bindings = new BindingRepository(store)
  const ctx = new Context()
  cleanups.push(async () => { for (const h of held.values()) h.release(); await ctx.fiber.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(TokenMeter); await ctx.plugin(Loader)
  installModelSelectionProjection(ctx)
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (name === '@deepseek-ai/dsh-compaction-basic') return Basic
    throw new Error(name)
  } } as never
  const requests: GenerateOptions[] = [], resolved: string[] = []
  let onMetadata: ((model: string) => void) | undefined
  let holdStreams = false, active = 0, maximumActive = 0, closed = 0
  const held = new Map<string, { release(): void; request: GenerateOptions }>()
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      resolved.push(model); onMetadata?.(model)
      return { provider, id: model, name: model, context: { contextWindow: model === 'worker' ? 32_000 : model === 'lead-small' ? 48_000 : model.startsWith('summary') ? 16_000 : 96_000 },
        defaultMaxTokens: 8192, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'max' }] } }
    }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      const compaction = request.purpose === 'compaction'
      if (compaction) { active++; maximumActive = Math.max(active, maximumActive) }
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: compaction
          ? `Synthetic checkpoint for ${request.sessionId}: preserve requirements, frozen test and pending verification.` : 'Synthetic fixture acknowledged.' } }
        if (compaction && holdStreams) {
          let release!: () => void
          const pending = new Promise<void>(resolve => { release = resolve })
          held.set(request.sessionId!, { release, request })
          let abort!: () => void
          const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(request.signal?.reason ?? new Error('Stream cancelled'))
            if (request.signal?.aborted) abort()
            else request.signal?.addEventListener('abort', abort, { once: true })
          })
          try { await Promise.race([pending, cancelled]); request.signal?.throwIfAborted() }
          finally { request.signal?.removeEventListener('abort', abort) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { if (compaction) { active--; closed++ } }
    }
  }
  ctx.llm.registerAdapter(['physical'], new Adapter())
  ctx.llm.registerAdapter(['dsh-model-fusion'], new FusionCatalogAdapter())
  const owner = (agent: any) => {
    const isWorker = options.workerOwner && agent.id === 'compat-b'
    const binding = bindings.read(isWorker ? 'compat-a' : agent.id)?.binding
    return binding?.selected ? { binding, role: isWorker ? 'worker' as const : 'lead' as const } : undefined
  }
  const route = (binding: any, role: 'lead' | 'worker') => readModelControl(store, binding)!.routes[role]
  const stopRouting = installCompactionRouting(ctx, { owner, route, epoch: binding => readModelControl(store, binding)!.epoch })
  const guard = new NativeContextGuard(ctx, store, owner, (_owner, reason) => { throw new Error(reason) }, undefined, undefined, route)
  const stopGuard = guard.install(() => {}, () => {})
  const registry = new CompactionRouteRegistry()
  let controller!: Controller
  const service = ctx.plugin({ name: 'compat-saviour', inject: ['agents', 'llm', 'tokenMeter', 'sessionProjections'], apply(child: Context) {
    child.provide('compactionRoutes', registry)
    controller = new Controller(child, { get: () => ({ enabled: true, mode: 'rescue', provider: 'physical', model: 'wrong-global-summary', reasoningEffort: '' }) } as never, registry)
  } })
  await service
  const agents = []
  const prompts = { lead: 'Lead fixture', worker: 'Worker fixture', compact: 'Summary fixture' }
  for (const [id, model] of [['compat-a', 'lead'], ['compat-b', 'lead-small']]) {
    const agent = (await ctx.agents.create({ sessionId: SessionId(id!), agentOptions: { provider: 'physical', model: model!, maxTokens: 1024 } })).agent
    const profile = completeProfile({ id, version: '1', enabled: true, interactionMode: 'model-like',
      lead: { provider: 'physical', model }, worker: { provider: 'physical', model: 'worker' },
      compactor: { route: { provider: 'physical', model: options.distinctCompactors && id === 'compat-b' ? 'summary-b' : 'summary', reasoningEffort: 'max' }, maxOutputTokens: options.distinctCompactors && id === 'compat-b' ? 1024 : 2048 } }, prompts)
    bindings.select(agent.id, TaskId(id!), { profile, prompts })
    await agent.ctx.plugin({ inject: ['loader'], async apply(child: Context) {
      await child.loader.create({ id: 'basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false } })
    } })
    await ctx.loader.await()
    for (const text of ['Synthetic requirement and frozen test. '.repeat(700), 'Recent constraint remains authoritative. '.repeat(400)]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }] })); await agent.whenIdle()
    }
    agent.session.append('model/selection', { provider: 'dsh-model-fusion', model: 'auto' })
    agents.push(agent)
  }
  cleanups.push(async () => { stopRouting(); stopGuard() })
  return { ctx, store, bindings, agents, registry, controller, requests, resolved,
    stopRouting,
    hold: () => { holdStreams = true }, held,
    streamState: () => ({ active, maximumActive, closed }),
    onMetadata: (fn: (model: string) => void) => { onMetadata = fn } }
}

it('Fusion and Saviour plan with session-frozen metadata and dispatch the same bounded compactor through native llm.stream', async () => {
  const f = await fixture(), [a, b] = f.agents
  expect(f.controller.current(a)).toMatchObject({ model: 'lead' })
  expect(f.controller.current(b)).toMatchObject({ model: 'lead-small' })
  expect(await f.controller.context(a.id)).toMatchObject({ contextWindow: 96_000 })
  expect(await f.controller.context(b.id)).toMatchObject({ contextWindow: 48_000 })
  expect(await f.ctx.llm.resolveModelInfo('dsh-model-fusion', 'auto')).not.toHaveProperty('context')
  f.resolved.length = 0
  await a.ctx.get('compaction')!.compactNow(a, new AbortController().signal)
  const summaries = f.requests.filter(request => request.purpose === 'compaction')
  expect(summaries.length).toBeGreaterThan(0)
  for (const request of summaries) expect(request).toMatchObject({ provider: 'physical', model: 'summary',
    reasoningEffort: 'max', maxTokens: 2048, sessionId: a.id })
  expect(f.resolved).toContain('lead'); expect(f.resolved).toContain('summary')
  expect(f.resolved).not.toContain('wrong-global-summary')
  expect(a.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  expect(f.controller.current(b)).toMatchObject({ model: 'lead-small' })
})

it.each(['epoch', 'unload', 'cancel'])('%s during metadata resolution cancels compaction before any stream or summary commit', async mode => {
  const f = await fixture(), a = f.agents[0]!
  const binding = f.bindings.read(a.id)!.binding
  const cancel = new AbortController()
  f.onMetadata(model => {
    if (model !== 'summary') return
    if (mode === 'unload') { f.stopRouting(); return }
    if (mode === 'cancel') { cancel.abort(new Error('Synthetic cancellation')); return }
    const view = readModelControl(f.store, binding)!
    f.store.writeDocument(`model-control:${a.id}`, view.revision, { ...view, epoch: view.epoch + 1 })
  })
  let failure: unknown
  try { await a.ctx.get('compaction')!.compactNow(a, cancel.signal) } catch (error) { failure = error }
  expect(errorChain(failure)).toMatch(mode === 'cancel' ? /Synthetic cancellation/ : /route (changed|owner unloaded)/)
  expect(f.requests.filter(request => request.purpose === 'compaction')).toHaveLength(0)
  expect(a.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
})

function history(agent: any) {
  const events = agent.session.snapshotEvents(), nodes = [...agent.session.surface.nodes]
  const messages = nodes.map(seq => events.find((event: any) => event.seq === seq))
  return { events, nodes, bodySHA256: createHash('sha256').update(JSON.stringify(messages)).digest('hex') }
}
function noHistoryReplacement(agent: any, before: ReturnType<typeof history>) {
  expect(agent.session.snapshotEvents().slice(0, before.events.length)).toEqual(before.events)
  expect(history(agent).bodySHA256).toBe(before.bodySHA256)
  expect(agent.session.surface.nodes).toEqual(before.nodes)
  expect(agent.session.snapshotEvents().filter((e: any) => e.type === 'compaction/summary')).toHaveLength(0)
  expect(agent.session.snapshotEvents().at(-1)?.type).toBe('compaction/end')
}
const compact = async (agent: any, signal = new AbortController().signal) => agent.ctx.get('compaction')!.compactNow(agent, signal)
const settled = (promise: Promise<unknown>) => promise.then(() => ({ ok: true, error: '' }), error => ({ ok: false, error: errorChain(error) }))

it.each(['cancel', 'unload'])('mid-stream %s preserves history, aborts the active request and closes its iterator', async mode => {
  const f = await fixture(), a = f.agents[0]!, before = history(a), abort = new AbortController()
  f.hold()
  const done = settled(compact(a, abort.signal))
  await expect.poll(() => f.held.size).toBe(1)
  const request = f.held.get(a.id)!.request
  expect(f.streamState().active).toBe(1)
  if (mode === 'cancel') abort.abort(new Error('Synthetic mid-stream cancellation'))
  else f.stopRouting()
  const result = await done
  expect(result.ok).toBe(false)
  expect(result.error).toMatch(mode === 'cancel' ? /Synthetic mid-stream cancellation/ : /route (changed|owner unloaded)/)
  expect(request.signal?.aborted).toBe(true)
  expect(f.streamState()).toMatchObject({ active: 0, maximumActive: 1, closed: 1 })
  noHistoryReplacement(a, before)
  supplementalResults.push({ case: 'mid-stream-' + mode, partialContentDelivered: true, requestAborted: true,
    historySHA256: before.bodySHA256, historyPreserved: true, stream: f.streamState(), summaryCommits: 0 })
})

it('worker-role compaction uses its parent binding worker context and frozen compactor', async () => {
  const f = await fixture({ workerOwner: true }), [parent, worker] = f.agents
  const parentBefore = history(parent), workerBefore = history(worker)
  expect(f.controller.current(worker)).toMatchObject({ provider: 'physical', model: 'worker' })
  expect(await f.controller.context(worker.id)).toMatchObject({ contextWindow: 32_000 })
  await compact(worker)
  const requests = f.requests.filter(r => r.purpose === 'compaction')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ sessionId: worker.id, provider: 'physical', model: 'summary', reasoningEffort: 'max', maxTokens: 2048 })
  expect(worker.session.snapshotEvents().some(e => e.type === 'compaction/summary')).toBe(true)
  expect(worker.session.snapshotEvents().slice(0, workerBefore.events.length)).toEqual(workerBefore.events)
  expect(history(parent).bodySHA256).toBe(parentBefore.bodySHA256)
  supplementalResults.push({ case: 'worker-role', mapping: 'synthetic Worker Agent owned by parent frozen binding; no remote delegation',
    contextWindow: 32_000, provider: 'physical', model: 'summary', effort: 'max', cap: 2048,
    parentUnchanged: true, workerOriginalLogPreserved: true, summaryCommits: 1 })
})

it('same-session overlapping compaction is rejected without a second stream or duplicate summary', async () => {
  const f = await fixture(), a = f.agents[0]!
  f.hold()
  const first = settled(compact(a))
  await expect.poll(() => f.held.size).toBe(1)
  const second = await settled(compact(a))
  expect(second.ok).toBe(false)
  expect(f.requests.filter(r => r.purpose === 'compaction')).toHaveLength(1)
  f.held.get(a.id)!.release()
  expect((await first).ok).toBe(true)
  expect(a.session.snapshotEvents().filter(e => e.type === 'compaction/summary')).toHaveLength(1)
  supplementalResults.push({ case: 'same-session-overlap', secondRejected: true, error: second.error,
    nativeStubStreams: 1, summaryCommits: 1, stream: f.streamState() })
})

it.each(['both-complete', 'cancel-first'])('two sessions preserve independent models and budgets under overlap: %s', async mode => {
  const f = await fixture({ distinctCompactors: true }), [a, b] = f.agents
  const beforeA = history(a), beforeB = history(b), abortA = new AbortController()
  f.hold()
  const doneA = settled(compact(a, abortA.signal)), doneB = settled(compact(b))
  await expect.poll(() => f.held.size).toBe(2)
  expect(f.streamState()).toMatchObject({ active: 2, maximumActive: 2 })
  expect(f.held.get(a.id)!.request).toMatchObject({ model: 'summary', maxTokens: 2048, sessionId: a.id })
  expect(f.held.get(b.id)!.request).toMatchObject({ model: 'summary-b', maxTokens: 1024, sessionId: b.id })
  if (mode === 'cancel-first') abortA.abort(new Error('Only cancel session A'))
  else f.held.get(a.id)!.release()
  const resultA = await doneA
  expect(resultA.ok).toBe(mode === 'both-complete')
  expect(history(b).bodySHA256).toBe(beforeB.bodySHA256)
  expect(f.held.get(b.id)!.request.signal?.aborted).toBe(false)
  if (mode === 'cancel-first') noHistoryReplacement(a, beforeA)
  f.held.get(b.id)!.release()
  expect((await doneB).ok).toBe(true)
  const summaryA = a.session.snapshotEvents().filter(e => e.type === 'compaction/summary')
  const summaryB = b.session.snapshotEvents().filter(e => e.type === 'compaction/summary')
  expect(summaryA).toHaveLength(mode === 'both-complete' ? 1 : 0)
  expect(summaryB).toHaveLength(1)
  expect(JSON.stringify(summaryB[0]?.data.summary)).toContain(b.id)
  if (mode === 'both-complete') expect(JSON.stringify(summaryA[0]?.data.summary)).toContain(a.id)
  expect(f.streamState()).toMatchObject({ active: 0, maximumActive: 2, closed: 2 })
  supplementalResults.push({ case: 'two-session-' + mode, maximumStubConcurrency: 2,
    models: ['summary', 'summary-b'], caps: [2048, 1024], summaryCommits: [summaryA.length, summaryB.length],
    cancellationIsolated: true, sessionBUnchangedUntilItsOwnCommit: true, stream: f.streamState() })
})
