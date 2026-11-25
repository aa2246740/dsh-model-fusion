import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmCallConfig,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmResolvedModelInfo,
  ModelModality,
  PreparedAdapterCall,
  RequestMessage,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { PhysicalRoute } from '../contracts.js'
import type { ResolvedProfile } from '../profile/resolve.js'
import type { FusionCoordinator } from './coordinator.js'
import { nativeRequestAgent } from './native-request.js'

type AdapterImageRef = Parameters<LlmAdapter['imageRequestTarget']>[2]
type AdapterImageTarget = ReturnType<LlmAdapter['imageRequestTarget']>

export const FUSION_PROVIDER = 'dsh-model-fusion'
export const FUSION_MODEL = 'auto'
export const isFusionSelection = (route: { provider?: string; model?: string } | undefined): boolean =>
  route?.provider === FUSION_PROVIDER && route.model === FUSION_MODEL

/** Resolves the configured Lead's declared input modalities; undefined means unconfigured or unverifiable. */
export type LeadInputModalities = () => Promise<readonly ModelModality[] | undefined>

export interface FusionAdapterHooks {
  readonly ctx: Context
  readonly leadInputModalities?: LeadInputModalities
  readonly coordinator: () => FusionCoordinator | undefined
  readonly configuredLead?: () => PhysicalRoute | undefined
}

const forwardedFusionRequests = new WeakSet<GenerateOptions>()
const rawFusionRequest = new AsyncLocalStorage<GenerateOptions | undefined>()
const rawCaptureSlots = new WeakMap<Context, { count: number; dispose: () => void }>()

/**
 * Whether an `llm/stream` request is the internal physical dispatch forwarded
 * by {@link FusionCatalogAdapter} after the outer `dsh-model-fusion/auto` pass
 * already ran Fusion's context, budget, usage, and keepalive observers.
 */
export function isForwardedFusionRequest(options: GenerateOptions): boolean {
  return forwardedFusionRequests.has(options)
}

/**
 * Capture raw pre-`adapterStream` `dsh-model-fusion/auto` requests so
 * {@link FusionCatalogAdapter} can forward the unprojected messages, tools,
 * `toolHistory`, and pre-Fusion `replayState` to Pass 2, letting the physical
 * adapter run tool-update, image, file, and `forAdapter` projection exactly once.
 */
export function installFusionRequestCapture(ctx: Context): () => void {
  const existing = rawCaptureSlots.get(ctx)
  if (existing) {
    existing.count++
    let released = false
    return () => {
      if (released) return
      released = true
      existing.count--
      if (existing.count === 0) {
        rawCaptureSlots.delete(ctx)
        existing.dispose()
      }
    }
  }
  const dispose = ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    if (!isFusionSelection(options) || isForwardedFusionRequest(options)) {
      yield* next()
      return
    }
    const iterator = rawFusionRequest.run(options, () => next()[Symbol.asyncIterator]())
    try {
      while (true) {
        const step = await rawFusionRequest.run(options, () => iterator.next())
        if (step.done) return
        yield step.value
      }
    } finally {
      await rawFusionRequest.run(options, () => iterator.return?.())
    }
  })
  const slot = { count: 1, dispose }
  rawCaptureSlots.set(ctx, slot)
  let released = false
  return () => {
    if (released) return
    released = true
    slot.count--
    if (slot.count === 0) {
      rawCaptureSlots.delete(ctx)
      slot.dispose()
    }
  }
}

const FUSION_MODEL_NAME = 'Fusion · 自动'
const FUSION_MODEL_DESCRIPTION = 'Lead 与 Worker 协作。在设置 → Fusion 中配置模型。'

/**
 * Virtual model adapter for `dsh-model-fusion/auto`.
 * Keeps the user's native selection on `Fusion · 自动` (so the DSH model menu,
 * `FusionHint`, and `agent/request` selection-lock invariant stay intact) while
 * resolving capabilities and forwarding Lead streams to the active physical Lead.
 */
export class FusionCatalogAdapter extends LlmAdapter {
  readonly #leadInputModalities?: LeadInputModalities
  readonly #hooks?: FusionAdapterHooks

  constructor(input?: LeadInputModalities | FusionAdapterHooks) {
    super()
    if (typeof input === 'function') this.#leadInputModalities = input
    else if (input) {
      this.#hooks = input
      this.#leadInputModalities = input.leadInputModalities
    }
  }

  override providerInfo(provider: string) { return { id: provider, name: 'Fusion' } }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // The Lead is the only role that reads user content, so the entry admits
    // exactly what the configured Lead admits; text-only until it resolves.
    const lead = await this.#resolveLeadModalities()
    return [{
      provider, id: FUSION_MODEL, name: FUSION_MODEL_NAME,
      description: FUSION_MODEL_DESCRIPTION,
      inputModalities: [...new Set<ModelModality>(['text', ...lead])],
    }]
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (provider !== FUSION_PROVIDER || model !== FUSION_MODEL) throw new Error('Unknown local Fusion selection')
    const hooks = this.#hooks
    const agent = this.#activeAgent()
    const resolved = this.#resolveLeadTarget(agent)
    if (hooks && resolved.route) {
      try {
        const physical = await hooks.ctx.llm.resolveModelInfo(resolved.route.provider, resolved.route.model, signal)
        return this.#projectModelInfo(provider, physical)
      } catch (error) {
        if (resolved.bound) throw error
      }
    }
    return (await this.listModels(provider))[0]!
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    if (provider !== FUSION_PROVIDER || model !== FUSION_MODEL) throw new Error('Unknown local Fusion selection')
    const hooks = this.#hooks
    const agent = this.#activeAgent()
    const resolved = this.#resolveLeadTarget(agent)
    if (hooks && agent && resolved.bound && resolved.coordinator && resolved.route) {
      const physical = await hooks.ctx.llm.resolveModelInfo(resolved.route.provider, resolved.route.model, signal)
      const route = resolved.route
      const coordinator = resolved.coordinator
      return {
        model: this.#projectModelInfo(provider, physical),
        stream: options => this.#forward(hooks.ctx, coordinator, agent, route, options),
      }
    }
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    const hooks = this.#hooks
    if (!hooks || provider !== FUSION_PROVIDER || model !== FUSION_MODEL) return undefined
    const route = this.#resolveLeadTarget(this.#activeAgent()).route
    if (!route || isFusionSelection(route)) return undefined
    try { return hooks.ctx.llm.imageRequestPricing(route.provider, route.model) }
    catch { return undefined }
  }

  override imageRequestTarget(provider: string, model: string, image: AdapterImageRef): AdapterImageTarget {
    const hooks = this.#hooks
    if (!hooks || provider !== FUSION_PROVIDER || model !== FUSION_MODEL) return super.imageRequestTarget(provider, model, image)
    const route = this.#resolveLeadTarget(this.#activeAgent()).route
    if (!route || isFusionSelection(route)) return super.imageRequestTarget(provider, model, image)
    try { return hooks.ctx.llm.imageRequestTarget(route.provider, route.model, image) }
    catch { return super.imageRequestTarget(provider, model, image) }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const hooks = this.#hooks
    const agent = this.#activeAgent(options)
    const resolved = this.#resolveLeadTarget(agent)
    if (hooks && agent && resolved.bound && resolved.coordinator && resolved.route) {
      yield* this.#forward(hooks.ctx, resolved.coordinator, agent, resolved.route, options)
      return
    }
    throw new Error('Fusion 尚未就绪。请前往设置 → Fusion 配置 Lead 和 Worker。')
  }

  #activeAgent(options?: GenerateOptions): Agent | undefined {
    const hooks = this.#hooks
    if (!hooks) return undefined
    if (options) {
      const fromOptions = nativeRequestAgent(hooks.ctx, options)
      if (fromOptions) return fromOptions
    }
    const raw = rawFusionRequest.getStore()
    if (raw) {
      const fromRaw = nativeRequestAgent(hooks.ctx, raw)
      if (fromRaw) return fromRaw
    }
    return hooks.ctx.agents.currentInitiator()
  }

  async #resolveLeadModalities(): Promise<readonly ModelModality[]> {
    if (this.#leadInputModalities) return (await this.#leadInputModalities()) ?? []
    const hooks = this.#hooks
    const route = this.#resolveLeadTarget(this.#activeAgent()).route
    if (!hooks || !route || isFusionSelection(route)) return []
    try { return (await hooks.ctx.llm.resolveModelInfo(route.provider, route.model)).inputModalities ?? [] }
    catch { return [] }
  }

  #resolveLeadTarget(agent?: Agent): { bound: boolean; coordinator?: FusionCoordinator; route?: PhysicalRoute } {
    const coordinator = this.#hooks?.coordinator()
    if (agent && coordinator) {
      const owner = coordinator.owner(agent)
      if (owner?.role === 'lead') {
        return { bound: true, coordinator, route: coordinator.modelControl.route(owner.binding, 'lead') }
      }
    }
    let configured = this.#hooks?.configuredLead?.() ?? coordinator?.options.profile.profile.lead
    if (!configured && coordinator) {
      const active = coordinator.bindings.selected()
      if (active.length === 1) configured = coordinator.modelControl.route(active[0]!, 'lead')
    }
    return { bound: false, coordinator, route: configured }
  }

  #projectModelInfo(provider: string, physical: LlmResolvedModelInfo): LlmResolvedModelInfo {
    // Deliberately omit `reasoning`: the outer `dsh-model-fusion/auto` selection
    // carries no user-facing effort parameter; the physical Lead route supplies its own.
    const inputModalities = [...new Set<ModelModality>(['text', ...(physical.inputModalities ?? [])])]
    return {
      provider, id: FUSION_MODEL, name: FUSION_MODEL_NAME, description: FUSION_MODEL_DESCRIPTION,
      inputModalities,
      ...(physical.context === undefined ? {} : { context: { contextWindow: physical.context.contextWindow } }),
      ...(physical.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: physical.defaultMaxTokens }),
      ...(physical.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: physical.systemPromptUpdate }),
      ...(physical.toolUpdate === undefined ? {} : { toolUpdate: physical.toolUpdate }),
    }
  }

  async *#forward(
    ctx: Context,
    coordinator: FusionCoordinator,
    agent: Agent,
    route: PhysicalRoute,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (isFusionSelection(route)) throw new Error('Fusion Lead route cannot reference dsh-model-fusion/auto')
    // Prefer the raw pre-adapterStream request captured on Pass 1 so Pass 2 runs
    // tool-update, file/image, and forAdapter replayState projections exactly once
    // against the physical model and adapter.
    const raw = rawFusionRequest.getStore() ?? options
    const maxTokens = raw.maxTokens ?? options.maxTokens
    const temperature = raw.temperature ?? options.temperature
    const stop = raw.stop ?? options.stop
    const signal = raw.signal ?? options.signal
    const physicalCallConfig: LlmCallConfig = {
      provider: route.provider,
      model: route.model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(stop === undefined ? {} : { stop }),
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
    }
    const prepared = await rawFusionRequest.run(undefined, () => ctx.llm.prepareCall(physicalCallConfig, signal))
    const messages = this.#rewriteMessages(coordinator, agent.id, route, raw.messages)
    const physicalOptions: GenerateOptions = {
      ...raw,
      ...prepared.config,
      messages,
    }
    if (Object.isFrozen(raw)) Object.freeze(physicalOptions)
    forwardedFusionRequests.add(physicalOptions)
    coordinator.recordLeadDispatch(agent.id, route)
    const physicalIterator = rawFusionRequest.run(undefined, () => prepared.stream(physicalOptions)[Symbol.asyncIterator]())
    try {
      while (true) {
        const step = await rawFusionRequest.run(undefined, () => physicalIterator.next())
        if (step.done) return
        yield step.value
      }
    } finally {
      await rawFusionRequest.run(undefined, () => physicalIterator.return?.())
    }
  }

  #rewriteMessages(
    coordinator: FusionCoordinator,
    sessionId: string,
    activeRoute: PhysicalRoute,
    messages: readonly RequestMessage[],
  ): RequestMessage[] {
    let changed = false
    const rewritten = messages.map((message): RequestMessage => {
      if (message.role !== 'assistant' || message.source.provider !== FUSION_PROVIDER) return message
      const recorded = coordinator.leadMessageRoute(sessionId, message.id)
      changed = true
      if (recorded) {
        return freezeMessage({
          ...message,
          source: {
            kind: 'model',
            provider: recorded.provider,
            model: recorded.model,
            ...(message.source.replayState === undefined ? {} : { replayState: message.source.replayState }),
          },
        })
      }
      // Without provenance for a historical virtual-provider message, drop
      // replayState so a switched provider never receives foreign opaque state.
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: activeRoute.provider, model: activeRoute.model },
      })
    })
    return changed ? rewritten : [...messages]
  }
}

/** Public native lifecycle integration. No model-menu replacement or Host patch. */
export function installNativeFusionSelection(ctx: Context, input: {
  coordinator(): FusionCoordinator | undefined
  profile(): ResolvedProfile | undefined
  selection(agent: Agent): PhysicalRoute | undefined
}): () => void {
  const pending = new Map<string, Promise<void>>()
  const failures = new Map<string, string>()
  const desired = new Map<string, PhysicalRoute>()
  const selection = (agent: Agent) => desired.get(agent.id) ?? input.selection(agent)
  const selected = (agent: Agent) => input.coordinator()?.bindings.read(agent.id)?.binding.selected === true
  const change = (agent: Agent) => {
    if (agent.session.header.parentSession || pending.has(agent.id)) return
    const coordinator = input.coordinator(), profile = input.profile(), route = selection(agent)
    if (!coordinator) return
    if (isFusionSelection(route)) {
      if (!selected(agent) && profile) coordinator.selectBeforeAssembly(agent, profile)
      if (selected(agent)) {
        // Persist a saved default selection before step preparation reads
        // `agent.model.current()`, keeping the native menu on `Fusion · 自动`.
        const intent = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
        if (!isFusionSelection(intent?.data)) agent.model.select({
          provider: FUSION_PROVIDER, model: FUSION_MODEL,
        })
        failures.delete(agent.id)
      }
      return
    }
    if (!selected(agent)) return
    const transition = (async () => {
      if (agent.status !== 'idle') await coordinator.pause(agent)
      await coordinator.clear(agent)
      failures.delete(agent.id)
    })().catch(error => { failures.set(agent.id, String(error)) }).finally(() => { pending.delete(agent.id) })
    pending.set(agent.id, transition)
  }
  const disposers = [
    installFusionRequestCapture(ctx),
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection') return
      desired.set(session.id, event.data)
      const agent = ctx.agents.get(SessionId(session.id))
      if (agent && (agent.status === 'idle' || !isFusionSelection(event.data))) change(agent)
      else if (agent && !selected(agent)) agent.cancel({ kind: 'hook', reason: 'Fusion selection takes effect after this turn settles' }, { keepInbox: true })
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running' || agent.session.header.parentSession) return
      if (pending.has(agent.id) && selected(agent)) {
        agent.cancel({ kind: 'hook', reason: 'Model switch is draining the previous Fusion task' }, { keepInbox: true })
        return
      }
      // The synchronous running reservation precedes prompt/tool assembly.
      try { change(agent) } catch (error) { failures.set(agent.id, String(error)) }
    }),
    ctx.on('agent/request', async (payload, next) => {
      const config = await next(), agent = payload.agent
      if (agent.session.header.parentSession) return config
      const route = selection(agent)
      if ((pending.has(agent.id) && selected(agent)) || failures.has(agent.id)) throw new Error(failures.get(agent.id) ?? 'Fusion 正在完成模型切换，请稍后继续')
      if (isFusionSelection(route)) {
        if (!selected(agent)) throw new Error('请先在设置 → Fusion 配置 Lead 和 Worker，再继续此会话。')
      } else if (selected(agent)) throw new Error('先停止当前 Fusion 任务，再切换模型。')
      return config
    }, { prepend: true }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
