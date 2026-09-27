import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { PhysicalRoute, Role, TokenMeasurement } from '../contracts.js'
import { inputBudget, safetyTokens } from '../context/guard.js'
import { digestOf } from '../digest.js'
import { FUSION_CONTEXT_BUDGET } from '../errors.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'
import { nativeRequestAgent } from './native-request.js'
import { FUSION_TASK_CONTEXT, type NativeTaskContext } from './native-task-context.js'
import type { NativeAuxiliaryRequests } from './native-auxiliary.js'
import { routeNativeCompaction } from './native-compaction.js'

type Owner = { binding: SessionBinding; role: Role }
interface ContextCheck {
  route: PhysicalRoute
  measurement: TokenMeasurement
  budget: number
  purpose: GenerateOptions['purpose'] | 'conversation' | 'cache-keepalive'
  logRevision: number
  nativeBaseline: string
  minimumRetainedInputTokens: number
}
interface RejectedRequest extends ContextCheck { owner: Owner; recordId: string }

/** Optional summary routing, then final admission and the Host's single compaction owner. */
export class NativeContextGuard {
  readonly #rejected = new WeakMap<Agent, RejectedRequest>()
  constructor(readonly ctx: Context, readonly store: SqliteFusionStore,
    readonly owner: (agent: Agent) => Owner | undefined,
    readonly blocked: (owner: Owner, reason: string) => void,
    readonly taskContext?: NativeTaskContext,
    readonly auxiliary?: NativeAuxiliaryRequests,
    readonly route?: (binding: SessionBinding, role: Role) => PhysicalRoute) {}

  async measure(agent: Agent, owner: Owner, request: GenerateOptions): Promise<ContextCheck> {
    const meter = this.ctx.get('tokenMeter')
    if (!meter) throw new Error('Fusion requires the native tokenMeter service')
    const separateCompactor = request.purpose === 'compaction' && owner.binding.profile.compactor
    const route = separateCompactor ? separateCompactor.route : owner.binding.profile[owner.role]
    const policy = owner.binding.profile.context[owner.role]
    if (request.provider !== route.provider || request.model !== route.model) {
      throw new Error('Fusion request must use its frozen role or compactor model')
    }
    const logged = isAgentLoopRequest(request) ? agent.session.requestContext() : undefined
    const capacity = logged?.provider === request.provider && logged.model === request.model
      ? logged.contextWindow : (await this.ctx.llm.resolveModelInfo(request.provider, request.model, request.signal)).context?.contextWindow
    if (!Number.isSafeInteger(capacity) || Number(capacity) <= 0) throw new Error('The configured model does not disclose a usable context window')
    const contextWindow = Number(capacity), output = request.maxTokens
    if (!Number.isSafeInteger(output) || Number(output) <= 0) throw new Error('Fusion requires an explicit output token reservation')
    const { messages, tools, signal: _signal, sessionId: _sessionId, purpose: _purpose, system, ...config } = request
    const replay = meter.measure(agent.session, { config, ...(tools?.length ? { tools } : {}) })
    // The actual one-shot envelope can include a summary directive or tools not
    // on the current surface. Charge it too. JSON tool schemas use the public
    // message estimator with extra framing, rather than a private meter import.
    const text = (value: string) => meter.estimateMessage(createUserMessage({ content: [{ type: 'text', text: value }],
      source: { kind: 'plugin:dsh-model-fusion' } }))
    const fixed = (system ? text(system) : 0) + (tools?.length ? text(JSON.stringify(tools)) : 0)
    const actual = messages.reduce((total, message) => total + meter.estimateMessage(message.id ? message : createUserMessage({ content: message.content, source: { kind: 'plugin:dsh-model-fusion' } })), 0) + fixed
    const pinned = messages.flatMap(message => message.source?.kind === 'plugin:dsh-model-fusion'
      && message.source.form === 'snapshot' ? message.source.sections.filter(section => section.name === FUSION_TASK_CONTEXT) : []).at(-1)
    // A summary cannot shrink the required current task snapshot, system prompt
    // or tool schemas. Reject an impossible restore before charging a summary.
    const minimumRetainedInputTokens = fixed + (pinned ? text(pinned.text) : 0)
    // Replay includes cached history once, including any native usage anchor.
    // New surface deltas remain heuristic even when that anchor is measured.
    const measurement: TokenMeasurement = {
      // A separately routed summary reads only its selected region. The role's
      // full-history usage anchor cannot price this different model's request.
      inputTokens: this.auxiliary?.get(request) || separateCompactor ? actual : Math.max(replay.totalTokens, actual), reservedOutputTokens: Number(output), contextWindow,
      safetyTokens: safetyTokens(contextWindow, policy, 'heuristic'), quality: 'heuristic',
      requestDigest: digestOf({ ...config, messages, tools, system, purpose: request.purpose }),
    }
    // A summary repairs the role's soft target and must be allowed to read a
    // larger prefix; it is still subject to the physical window and spend cap.
    const effectivePolicy = request.purpose === 'compaction' ? { ...policy, targetInputTokens: contextWindow } : policy
    return { route, measurement, budget: inputBudget(effectivePolicy, contextWindow, Number(output), 'heuristic'),
      purpose: this.auxiliary?.get(request)?.purpose ?? request.purpose ?? 'conversation', logRevision: replay.logRevision,
      nativeBaseline: replay.baseline.kind, minimumRetainedInputTokens }
  }

  install(admit: (agent: Agent, owner: Owner, request: GenerateOptions) => void,
    ready: (agent: Agent, request: GenerateOptions) => void): () => void {
    const guard = this
    const disposeStream = this.ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
      const agent = nativeRequestAgent(guard.ctx, request), owner = agent && guard.owner(agent)
      if (!agent || !owner) { yield* next(); return }
      const auxiliary = guard.auxiliary?.get(request)
      ready(agent, request)
      if (owner.binding.profile.interactionMode === 'model-like') {
        // The native compactor and actual physical adapter own window/defaults.
        // Keep request/effect admission, without inventing a second output cap.
        routeNativeCompaction(request, owner.binding.profile, guard.route?.(owner.binding, owner.role))
        admit(agent, owner, request)
        yield* next()
        return
      }
      let check: ContextCheck
      try {
        routeNativeCompaction(request, owner.binding.profile)
        check = await guard.measure(agent, owner, request)
      }
      catch (error) {
        const reason = `Fusion 上下文检查失败：${error instanceof Error ? error.message : String(error)}`
        if (!auxiliary && request.purpose !== 'session-title') guard.blocked(owner, reason)
        yield { type: 'finish', reason: { kind: 'error', failure: new LlmError(reason, 'FUSION_CONTEXT_UNAVAILABLE').failure } }
        return
      }
      request.signal?.throwIfAborted()
      const accepted = check.measurement.inputTokens <= check.budget
      const recordId = `context-request:${owner.binding.taskId}:${randomUUID()}`
      guard.store.writeDocument(recordId, 0, { schemaVersion: 1, sessionId: agent.id, role: owner.role,
        taskId: owner.binding.taskId, checkedAt: new Date().toISOString(), admitted: accepted, ...check })
      if (!accepted) {
        const reason = `Fusion 上下文 ${check.measurement.inputTokens} 超过本轮预算 ${check.budget}（估算）`
        if (isAgentLoopRequest(request) && request.purpose === undefined) guard.#rejected.set(agent, { owner, recordId, ...check })
        else if (!auxiliary && request.purpose !== 'session-title') guard.blocked(owner, reason)
        yield { type: 'finish', reason: { kind: 'error', failure: new LlmError(reason, FUSION_CONTEXT_BUDGET).failure } }
        return
      }
      if (isAgentLoopRequest(request) && request.purpose === undefined) guard.#rejected.delete(agent)
      // Run spend reservation only after context admission; rejected local
      // attempts are neither upstream calls nor consumed call allowances.
      ready(agent, request)
      admit(agent, owner, request)
      yield* next()
    }, { prepend: true })
    const disposeRecovery = this.ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
      const rejected = this.#rejected.get(agent)
      if (failure.code !== FUSION_CONTEXT_BUDGET || !rejected) return next()
      this.#rejected.delete(agent)
      const { owner } = rejected
      const key = `context-recovery:${owner.binding.taskId}:${agent.id}:${turn}:${step}`
      const saved = this.store.readDocument(key)
      const prior = saved?.value as { attempts: number; priorInput: number } | undefined
      const attempts = prior?.attempts ?? 0
      const stop = (reason: string) => {
        const current = this.store.readDocument(key)
        const used = (current?.value as { attempts?: number } | undefined)?.attempts ?? attempts
        this.store.writeDocument(key, current?.revision ?? 0,
          { ...(current?.value as Record<string, unknown> | undefined), schemaVersion: 1, attempts: used,
            priorInput: rejected.measurement.inputTokens, state: 'blocked', reason, request: rejected.recordId })
        this.blocked(owner, reason)
        return undefined
      }
      if (signal.aborted) return stop('上下文压缩已中断；Fusion 已暂停并保留原始记录')
      if (rejected.minimumRetainedInputTokens > rejected.budget) return stop('Fusion 必须保留的任务内容已超过本轮上下文预算；请缩短最新交接或调整模型配置，原始记录已保留')
      if (attempts >= 2 || prior && rejected.measurement.inputTokens >= prior.priorInput) return stop('上下文压缩没有继续缩小；Fusion 已暂停，保留原始记录')
      // Web presets deliberately isolate this service. The public preset
      // addressor selects this Agent's existing owner without mounting another.
      const compaction = this.ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
        ?? agent.ctx.get('compaction') ?? this.ctx.get('compaction')
      const meter = this.ctx.get('tokenMeter')
      if (!compaction || !meter) return stop('DSH 未提供上下文压缩服务；Fusion 已暂停')
      const measurement = meter.measure(agent.session)
      const nodes = measurement.nodes
      const first = nodes.findIndex(node => agent.session.eventAt(node.seq)?.type !== 'system/message')
      // Keep the newest balanced unit and a bounded recent tail. Selection is
      // by surface position, never numeric seq order after a replacement.
      const policy = owner.binding.profile.context[owner.role]
      const keepTokens = Math.max(0, Math.floor(rejected.budget * policy.compactToFraction)
        - Math.max(0, measurement.totalTokens - measurement.surfaceTokens) - policy.reserveOutputTokens)
      let keep = nodes.length - 1
      while (keep > first && !toolPairingBalancedBefore(agent.session, nodes[keep]!.seq)) keep--
      let retained = nodes.slice(Math.max(0, keep)).reduce((sum, node) => sum + node.tokens, 0)
      for (let index = keep - 1; index > first; index--) {
        retained += nodes[index]!.tokens
        if (retained > keepTokens) break
        if (toolPairingBalancedBefore(agent.session, nodes[index]!.seq)) keep = index
      }
      if (first < 0 || keep <= first) return stop('当前输入没有可安全压缩的历史；请缩短输入或调整 Fusion 模型配置')
      this.store.writeDocument(key, saved?.revision ?? 0, { schemaVersion: 1, attempts: attempts + 1,
        priorInput: rejected.measurement.inputTokens, state: 'started', request: rejected.recordId })
      try {
        const checkpoint = this.taskContext?.prepareCompaction(agent, owner.binding, owner.role,
          nodes.slice(first, keep).map(node => node.seq))
        const result = await compaction.compactRegion(nodes[first]!.seq, nodes[keep - 1]!.seq, agent, signal)
        signal.throwIfAborted()
        if (checkpoint) this.taskContext!.restoreCompaction(agent, owner.binding, owner.role, checkpoint, result.compactionId)
        const after = meter.measure(agent.session).totalTokens
        this.store.writeDocument(key, this.store.readDocument(key)!.revision, { schemaVersion: 1, attempts: attempts + 1,
          priorInput: rejected.measurement.inputTokens, state: 'compacted', compactionId: result.compactionId,
          beforeTokens: rejected.measurement.inputTokens, beforeNativeTokens: measurement.totalTokens,
          afterTokens: after, request: rejected.recordId, ...(checkpoint ? { checkpoint } : {}) })
        // A provider usage anchor can be below the actual one-shot envelope.
        // Compare against the admitted measurement, then check the complete
        // frozen retry again. A still-rejected nonshrinking retry stops above.
        if (after >= rejected.measurement.inputTokens) return stop('DSH 压缩后上下文没有缩小；Fusion 已暂停')
        return { kind: 'retry' }
      } catch (error) {
        if (signal.aborted) return stop('上下文压缩已中断；Fusion 已暂停并保留原始记录')
        return stop(`DSH 上下文压缩失败；Fusion 已暂停：${error instanceof Error ? error.message : String(error)}`)
      }
    }, { prepend: true })
    return () => { disposeRecovery(); disposeStream() }
  }
}
