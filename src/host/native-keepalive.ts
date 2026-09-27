import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Role, TaskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'
import type { CacheMode } from './cache-defaults.js'
import { cacheHit } from './cache-policy.js'
import { NativeAuxiliaryRequests } from './native-auxiliary.js'
import { nativeRequestAgent } from './native-request.js'

/** R19 recovered schedule; one-token output is this plugin's conservative cap. */
export const KEEPALIVE_INTERVAL_MS = 285_000
export const KEEPALIVE_ATTEMPTS = 11
export interface KeepaliveClock {
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
}
const systemClock: KeepaliveClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref()
    return () => clearTimeout(timer)
  },
}
type Owner = { binding: SessionBinding; role: Role }
interface Callbacks {
  owner(agent: Agent): Owner | undefined
  allowed(agent: Agent, owner: Owner): boolean
  failed(agent: Agent, reason: string): void
  /** Per-model mode and interval (user setting, learned, defaults); absent: the pair profile and a fixed interval. */
  policy?(owner: Owner, provider: string, model: string): { mode: CacheMode; intervalMs: number }
  /** Evidence for learning and the settings page: a request after a wait, or a ping. */
  observe?(owner: Owner, provider: string, model: string, sample: { gapSeconds: number; ping: boolean; hit: boolean; cacheRead: number; input: number }): void
}
export interface KeepaliveRecord {
  schemaVersion: 1
  id: string
  taskId: TaskId
  sessionId: string
  role: Role
  profileDigest: string
  inputDigest: string
  createdAt: string
  updatedAt: string
  state: 'generating' | 'scheduled' | 'inflight' | 'stopped'
  attempts: number
  successes: number
  stopReason?: string
}
interface Series {
  agent: Agent
  owner: Owner
  input: GenerateOptions
  started: number
  controller: AbortController
  record: KeepaliveRecord
  revision: number
  cancelTimer?: () => void
  detachSourceAbort?: () => void
  intervalMs: number
}

/** Retains only plugin-owned requests in memory; never replays timers on restart. */
/** Explicit per-role choice; unset is automatic for the Lead (armed only on observed cache reads), off for the Worker. */
export function keepalivePolicy(binding: SessionBinding, role: Role): boolean | 'auto' {
  return binding.profile.cacheKeepalive?.[role] ?? (role === 'lead' ? 'auto' : false)
}

export class NativeCacheKeepalive {
  readonly #series = new Map<string, Series>()
  /** Start time of each agent's previous model request (real or ping): the wait before the next one. */
  readonly #lastStart = new Map<string, number>()
  readonly #pending = new Map<Promise<void>, { sessionId: string; taskId: TaskId }>()
  readonly #dispose: (() => void)[] = []
  #closed = false
  constructor(readonly ctx: Context, readonly store: SqliteFusionStore,
    readonly auxiliary: NativeAuxiliaryRequests, readonly callbacks: Callbacks,
    readonly clock: KeepaliveClock = systemClock) {}

  #active(row: Series): boolean {
    if (this.#closed || this.#series.get(row.agent.id) !== row || row.controller.signal.aborted
      || this.ctx.agents.get(row.agent.id) !== row.agent) return false
    const current = this.callbacks.owner(row.agent)
    return Boolean(current?.binding.selected && current.binding.taskId === row.owner.binding.taskId
      && current.binding.profile.digest === row.owner.binding.profile.digest && current.role === row.owner.role
      && this.#policy(current, row.input.provider, row.input.model).mode !== 'off' && this.callbacks.allowed(row.agent, current))
  }

  #policy(owner: Owner, provider: string, model: string): { mode: CacheMode; intervalMs: number } {
    if (this.callbacks.policy) return this.callbacks.policy(owner, provider, model)
    const legacy = keepalivePolicy(owner.binding, owner.role)
    return { mode: legacy === true ? 'on' : legacy === false ? 'off' : 'auto', intervalMs: KEEPALIVE_INTERVAL_MS }
  }

  #invalidate(row: Series): void {
    if (this.#series.get(row.agent.id) === row) this.#series.delete(row.agent.id)
    row.cancelTimer?.(); row.cancelTimer = undefined
    row.detachSourceAbort?.(); row.detachSourceAbort = undefined
    row.controller.abort()
  }

  #persist(row: Series): boolean {
    row.record.updatedAt = new Date().toISOString()
    try {
      row.revision = this.store.writeDocument(`keepalive:${row.record.taskId}:${row.record.id}`, row.revision, row.record)
      return true
    } catch (error) {
      this.#invalidate(row)
      this.callbacks.failed(row.agent, `Cache keepalive tracking failed: ${String(error)}`)
      return false
    }
  }

  #stop(row: Series, reason: string): void {
    this.#invalidate(row)
    if (row.record.state === 'stopped') return
    row.record.state = 'stopped'; row.record.stopReason = reason
    this.#persist(row)
  }

  stopSession(sessionId: string, reason: string): Promise<void> {
    const row = this.#series.get(sessionId)
    if (row) this.#stop(row, reason)
    return Promise.all([...this.#pending].filter(([, item]) => item.sessionId === sessionId).map(([pending]) => pending)).then(() => undefined)
  }

  stopTask(taskId: TaskId, reason: string): Promise<void> {
    for (const row of this.#series.values()) if (row.record.taskId === taskId) this.#stop(row, reason)
    return Promise.all([...this.#pending].filter(([, item]) => item.taskId === taskId).map(([pending]) => pending)).then(() => undefined)
  }

  /** Called again after asynchronous context measurement, before spend admission. */
  assertRequest(agent: Agent, request: GenerateOptions): void {
    const extra = this.auxiliary.get(request)
    if (!extra) return
    const row = this.#series.get(agent.id)
    if (!row || row.record.id !== extra.seriesId || row.record.attempts !== extra.iteration
      || row.record.taskId !== extra.taskId || row.record.sessionId !== extra.sessionId
      || row.record.profileDigest !== extra.profileDigest || row.record.role !== extra.role || !this.#active(row)) {
      throw new Error('Cache keepalive generation is no longer active')
    }
    request.signal?.throwIfAborted()
  }

  #arm(row: Series, deadline: number): void {
    if (!this.#active(row)) { this.#stop(row, 'inactive'); return }
    row.record.state = 'scheduled'
    if (!this.#persist(row)) return
    row.cancelTimer = this.clock.schedule(() => {
      row.cancelTimer = undefined
      const pending = Promise.resolve().then(() => this.#ping(row)).finally(() => { this.#pending.delete(pending) })
      this.#pending.set(pending, { sessionId: row.agent.id, taskId: row.record.taskId })
    }, Math.max(0, deadline - this.clock.now()))
  }

  async #ping(row: Series): Promise<void> {
    try {
      if (!this.#active(row)) { this.#stop(row, 'inactive'); return }
      const nextDeadline = this.clock.now() + row.intervalMs
      row.record.attempts++; row.record.state = 'inflight'
      if (!this.#persist(row)) return
      const request: GenerateOptions = { ...structuredClone(row.input), maxTokens: 1, signal: row.controller.signal,
        messages: [...structuredClone(row.input.messages), createUserMessage({ content: [{ type: 'text', text: 'continue' }],
          source: { kind: 'plugin:dsh-model-fusion' } })] }
      this.auxiliary.tag(request, { purpose: 'cache-keepalive', taskId: row.record.taskId, sessionId: row.agent.id,
        profileDigest: row.owner.binding.profile.digest, role: row.owner.role, seriesId: row.record.id, iteration: row.record.attempts })
      let success = false
      // Drain only: returned text, reasoning and tool calls never enter a Session
      // or execute. Public llm/stream still applies context, spend and usage hooks.
      for await (const chunk of this.ctx.llm.stream(request)) {
        if (chunk.type === 'finish') success = ['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason.kind)
      }
      if (success) row.record.successes++
      if (row.controller.signal.aborted || this.#series.get(row.agent.id) !== row) { this.#persist(row); return }
      if (!success) { this.#stop(row, 'request-failed'); return }
      if (row.record.attempts >= KEEPALIVE_ATTEMPTS) { this.#stop(row, 'attempt-limit'); return }
      this.#arm(row, nextDeadline)
    } catch {
      this.#stop(row, row.controller.signal.aborted ? 'cancelled' : 'request-failed')
    }
  }

  install(): void {
    const manager = this
    // Evidence for the settings page and the interval rule: how long each agent waited and whether its
    // prefix was still cached. Pings count too (they refresh the cache the next request relies on).
    this.#dispose.push(this.ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
      const agent = nativeRequestAgent(manager.ctx, request), owner = agent && manager.callbacks.owner(agent)
      const extra = manager.auxiliary.get(request), ping = extra?.purpose === 'cache-keepalive'
      if (!agent || !owner || !manager.callbacks.observe || (extra && !ping) || (!ping && (!isAgentLoopRequest(request) || request.purpose !== undefined))) {
        yield* next(); return
      }
      const started = manager.clock.now(), previous = manager.#lastStart.get(agent.id)
      manager.#lastStart.set(agent.id, started)
      let usage: { inputTokens?: number; cacheReadTokens?: number } | undefined
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        yield chunk
      }
      if (!usage || previous === undefined) return
      const cacheRead = usage.cacheReadTokens ?? 0, input = usage.inputTokens ?? 0
      try {
        manager.callbacks.observe(owner, request.provider, request.model,
          { gapSeconds: (started - previous) / 1000, ping, hit: cacheHit(cacheRead, input), cacheRead, input })
      } catch { /* evidence is advisory; never fail a model request over it */ }
    }))
    // Replacement invalidates the previous loop even if the next input is
    // rejected locally. An in-flight ping drains before a new request enters.
    this.#dispose.push(this.ctx.on('llm/stream', async function* (request, next) {
      if (!manager.auxiliary.get(request) && (isAgentLoopRequest(request) || request.purpose === 'compaction')) {
        const agent = nativeRequestAgent(manager.ctx, request)
        if (agent) await manager.stopSession(agent.id, request.purpose === 'compaction' ? 'compaction' : 'new-generation')
      }
      yield* next()
    }, { prepend: true }))
    // This observer is inside admission. Only actual admitted AgentLoop input
    // can establish a new prefix; unrelated one-shot calls cannot start timers.
    this.#dispose.push(this.ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
      const agent = nativeRequestAgent(manager.ctx, request), owner = agent && manager.callbacks.owner(agent)
      // Explicit per-role choice wins. Unset means automatic for the Lead: it waits minutes for the Sidekick,
      // and an expired prefix is resent uncached at the frontier price (round 4: 69% cache hits against 94%
      // alone). Automatic arming requires this route to have reported cache reads, so a route without prompt
      // caching never pays for pings.
      const policy = owner ? manager.#policy(owner, request.provider, request.model) : undefined
      if (!agent || !owner || !policy || policy.mode === 'off' || manager.auxiliary.get(request)
        || !isAgentLoopRequest(request) || request.purpose !== undefined || manager.#closed) { yield* next(); return }
      // Copy only public fields: no AgentLoop brand, source signal or mutable
      // session history. Adapters may normalize their own copy downstream.
      const input: GenerateOptions = structuredClone({ provider: request.provider, model: request.model,
        messages: request.messages, tools: request.tools, system: request.system, temperature: request.temperature,
        reasoningEffort: request.reasoningEffort, stop: request.stop, sessionId: request.sessionId })
      const row: Series = { agent, owner, input, started: manager.clock.now(), controller: new AbortController(), revision: 0, intervalMs: policy.intervalMs,
        record: { schemaVersion: 1, id: randomUUID(), taskId: owner.binding.taskId, sessionId: agent.id, role: owner.role,
          profileDigest: owner.binding.profile.digest, inputDigest: digestOf(input), createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), state: 'generating', attempts: 0, successes: 0 } }
      manager.#series.set(agent.id, row)
      if (request.signal) {
        const abort = () => { void manager.stopSession(agent.id, 'native-cancel') }
        request.signal.addEventListener('abort', abort, { once: true })
        row.detachSourceAbort = () => request.signal!.removeEventListener('abort', abort)
      }
      if (!manager.#persist(row)) throw new Error('Cache keepalive request tracking failed')
      let success = false, cached = policy.mode === 'on'
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'finish') success = ['stop', 'max-tokens', 'tool-calls'].includes(chunk.reason.kind)
          if (chunk.type === 'usage' && (chunk.usage.cacheReadTokens ?? 0) > 0) cached = true
          yield chunk
        }
      } finally {
        if (success && cached && !request.signal?.aborted && manager.#series.get(agent.id) === row) manager.#arm(row, row.started + row.intervalMs)
        else manager.#stop(row, cached ? 'generation-stopped' : 'no-cache-evidence')
      }
    }))
    this.#dispose.push(this.ctx.on('session/event', (session, event) => {
      if (event.type === 'compaction/start') void this.stopSession(session.id, 'compaction')
      if (event.type !== 'turn/end') return
      const row = this.#series.get(session.id)
      if (row && (event.data.reason.kind !== 'completed' || row.owner.role === 'worker' || !this.#active(row))) {
        void this.stopSession(session.id, 'agent-stopping')
      }
    }))
    this.#dispose.push(this.ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return
      for (const row of this.#series.values()) if (!this.#active(row)) void this.stopSession(row.agent.id, 'agent-idle')
    }))
    this.#dispose.push(this.ctx.on('agent/disposed', ({ agent }) => { this.#lastStart.delete(agent.id); void this.stopSession(agent.id, 'agent-disposed') }))
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const row of this.#series.values()) this.#stop(row, 'runtime-closing')
    await Promise.all(this.#pending.keys())
    for (const dispose of this.#dispose.reverse()) dispose()
  }
}
