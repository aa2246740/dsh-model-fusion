import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { requestOutputReservation } from '../context/guard.js'
import type { PhysicalRoute, Role } from '../contracts.js'
import type { SessionBinding } from './bindings.js'
import { digestOf } from '../digest.js'
import { FUSION_PROVIDER } from './native-selection.js'

const WORKER_ALWAYS_TOOLS = new Set(['fusion_read_state', 'fusion_read_evidence', 'fusion_submit_result'])

export interface FusionScopeCallbacks {
  route?(binding: SessionBinding, role: Role): PhysicalRoute
  beforeTurn?(agent: Agent, binding: SessionBinding, role: Role, turn: number): SessionBinding
  taskContext?(agent: Agent, binding: SessionBinding, role: Role): UserMessage | undefined
  beforeStep?(agent: Agent, binding: SessionBinding, role: Role): void
  projectMessage?(agent: Agent, binding: SessionBinding, role: Role, message: UserMessage): UserMessage
  /** All independent pause, budget, recovery and unknown-effect gates are checked here. */
  canAccess?(agent: Agent, binding: SessionBinding, role: Role): string | undefined
  /** Shared gates plus limits that apply only to admitting a new generation. */
  prepareRequest?(agent: Agent, binding: SessionBinding, role: Role, signal: AbortSignal): Promise<void>
  canRequest(agent: Agent, binding: SessionBinding, role: Role): string | undefined
  canExecute(exec: Readonly<ToolExecution>, binding: SessionBinding, role: Role): string | undefined
  beforeRequest(agent: Agent, turn: number, step: number, binding: SessionBinding, role: Role): void
  /** Disclosed context window for this physical model, read when the request is built. */
  modelLimits?(provider: string, model: string): Promise<{ contextWindow: number; defaultMaxTokens?: number; testedOutputCap?: number }>
  /** Stage tool allowlist. Undefined keeps the full inherited tool set. */
  readOnlyTools?(agent: Agent, binding: SessionBinding, role: Role): readonly string[] | undefined
  installTools(
    scope: Context,
    agent: Agent,
    binding: SessionBinding,
    role: Role,
    isAllowed: (toolName: string) => boolean,
  ): readonly (() => void)[]
}

interface ScopeEntry {
  readonly agent: Agent
  binding: SessionBinding
  readonly role: Role
  readonly dispose: (() => void)[]
  refreshTools(): void
  syncModel(): void
  ready: boolean
}

/** Role prompt, tool boundaries, and request gates live in the exact native Agent scope. */
export class NativeFusionScopes {
  readonly #entries = new Map<string, ScopeEntry>()
  constructor(private readonly callbacks: FusionScopeCallbacks) {}

  get(agent: Agent): { binding: SessionBinding; role: Role } | undefined {
    const entry = this.#entries.get(agent.id)
    return entry?.agent === agent ? { binding: entry.binding, role: entry.role } : undefined
  }

  assertReady(agent: Agent): void {
    const entry = this.#entries.get(agent.id)
    if (!entry || entry.agent !== agent || !entry.ready) throw new Error('Fusion Agent scope is not ready; execution is blocked')
    const reason = (this.callbacks.canAccess ?? this.callbacks.canRequest)(agent, entry.binding, entry.role)
    if (reason) throw new Error(reason)
  }

  install(agent: Agent, binding: SessionBinding, role: Role): void {
    const old = this.#entries.get(agent.id)
    if (old) {
      if (old.agent === agent && old.binding.taskId === binding.taskId && old.role === role && old.ready) return
      // A native continuable activation may be released between turns. Its
      // resumed Agent has the same durable id but a fresh exact scope.
      if (old.agent !== agent && (old.agent.status === 'idle' || old.agent.ctx.fiber?.uid === null)) this.detach(old.agent)
      else throw new Error('An existing Fusion scope must settle and detach before replacement')
    }
    const entry: ScopeEntry = {
      agent, binding: structuredClone(binding), role, dispose: [], ready: false,
      refreshTools: () => {}, syncModel: () => {},
    }
    this.#entries.set(agent.id, entry)
    const policy = entry.binding.profile.context[role]
    const scope = agent.ctx
    let presentationKey: string | undefined
    const stageDisposers: (() => void)[] = []
    const clearStage = () => { for (const dispose of stageDisposers.splice(0).reverse()) dispose() }
    entry.dispose.push(clearStage)
    if (typeof scope.effect === 'function') {
      entry.dispose.push(scope.effect(() => () => {
        if (this.#entries.get(agent.id) === entry) {
          entry.ready = false
          this.#entries.delete(agent.id)
        }
      }))
    }

    const isToolAllowed = (toolName: string): boolean => {
      if (!entry.ready) return false
      if (role === 'worker' && WORKER_ALWAYS_TOOLS.has(toolName)) return true
      const allowlist = this.callbacks.readOnlyTools?.(agent, entry.binding, role)
      return allowlist === undefined || allowlist.includes(toolName)
    }

    entry.syncModel = () => {
      if (role !== 'worker' || !agent.model) return
      const target = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
      const desired = {
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(target.reasoningEffort) }),
      }
      const current = agent.model.current()
      if (!current || current.provider !== desired.provider || current.model !== desired.model
        || current.reasoningEffort !== desired.reasoningEffort) {
        agent.model.select(desired)
      }
    }

    entry.refreshTools = () => {
      if (scope.fiber?.uid === null) {
        entry.ready = false
        if (this.#entries.get(agent.id) === entry) this.#entries.delete(agent.id)
        return
      }
      const tools = this.callbacks.readOnlyTools?.(agent, entry.binding, role)
      // Filter inherited restrictions against currently restrictable tools after
      // lifting any previous Fusion restriction. Subagents do not inherit from
      // the parent Agent scope in DSH 0.2.2, so Lead restrictions never reduce
      // Worker capabilities.
      if (tools === undefined) {
        if (presentationKey === 'null') return
        clearStage()
        presentationKey = 'null'
        return
      }
      clearStage()
      const inherited = [...new Set(tools)].filter(name =>
        !name.startsWith('fusion_')
        && name !== 'run_code'
        && (typeof scope.tools.get !== 'function' || scope.tools.get(name, agent) !== undefined),
      )
      stageDisposers.push(scope.tools.restrict({ allow: inherited }))
      presentationKey = JSON.stringify({ tools, inherited })
    }

    // Register the deny-only native guard first. A failed partial install stays closed.
    entry.dispose.push(scope.tools.guard(exec => {
      if (!entry.ready) return 'Fusion scope initialization failed'
      return this.callbacks.canExecute(exec, entry.binding, role)
    }))
    entry.dispose.push(scope.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/start' || !entry.ready || !this.callbacks.beforeTurn) return
      try {
        const nextBinding = this.callbacks.beforeTurn(agent, entry.binding, role, event.data.turn)
        if (nextBinding.sessionId !== entry.binding.sessionId || digestOf(nextBinding.profile) !== digestOf(entry.binding.profile)
          || digestOf(nextBinding.prompts) !== digestOf(entry.binding.prompts)) throw new Error('Task rollover must preserve the frozen route and prompts')
        entry.binding = structuredClone(nextBinding)
        entry.syncModel()
        entry.refreshTools()
      } catch (error) { entry.ready = false; throw error }
    }))
    entry.dispose.push(scope.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== agent || !entry.ready) return { kind: 'reject' }
      await this.callbacks.prepareRequest?.(agent, entry.binding, role, payload.signal)
      payload.signal.throwIfAborted()
      if (this.callbacks.canRequest(agent, entry.binding, role)) return { kind: 'reject' }
      this.callbacks.beforeStep?.(agent, entry.binding, role)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // Native compaction can run inside next(), after prompt assembly. Form
      // this user-role snapshot afterwards so the next request retains facts.
      const taskContext = this.callbacks.taskContext?.(agent, entry.binding, role)
      return { ...decision, messages: [...decision.messages.filter(message => !(message.source?.kind === 'model-selection' && message.source.form === 'notice'
        && message.source.summary.endsWith('dsh-model-fusion/auto'))).map(message =>
        this.callbacks.projectMessage?.(agent, entry.binding, role, message) ?? message), ...(taskContext ? [taskContext] : [])] }
    }, { prepend: true }))
    entry.dispose.push(scope.systemPrompt.section({ name: 'fusion-role', order: 90, text: entry.binding.prompts[role] }))
    entry.dispose.push(scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
      return { ...assembled, variables: { ...assembled.variables, provider: route.provider, model: route.model } }
    }, { prepend: true }))
    entry.dispose.push(scope.on('agent/request', async ({ agent: requesting, turn, step, signal }, next) => {
      this.assertReady(requesting)
      await this.callbacks.prepareRequest?.(requesting, entry.binding, role, signal)
      signal.throwIfAborted()
      const reason = this.callbacks.canRequest(requesting, entry.binding, role)
      if (reason) throw new Error(reason)
      const config = await next()
      const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
      this.callbacks.beforeRequest(agent, turn, step, entry.binding, role)
      // DSH 0.2.2 locks provider, model, and reasoningEffort at pre-step.
      // Lead physical routing happens inside FusionCatalogAdapter; Worker routing
      // happens through agentOptions / agent.model.select(). Only maxTokens may
      // still be adjusted here for legacy output reservation.
      if (entry.binding.profile.interactionMode === 'model-like') {
        if (role === 'worker' && config.maxTokens !== undefined) {
          const { maxTokens: _inherited, ...native } = config
          return native
        }
        return config
      }
      const disclosed = this.callbacks.modelLimits
        ? await this.callbacks.modelLimits(route.provider, route.model) : undefined
      const requested = role === 'lead' ? config.maxTokens : undefined
      const maxTokens = disclosed
        ? requestOutputReservation(disclosed.contextWindow, requested, disclosed.defaultMaxTokens, disclosed.testedOutputCap, policy.reserveOutputTokens)
        : Math.min(requested ?? policy.reserveOutputTokens, policy.reserveOutputTokens)
      return { ...config, maxTokens }
    }, { prepend: true }))
    // Forward the physical Lead provider's retry policy into native request-error
    // recovery when the outer step ran through `dsh-model-fusion/auto`.
    if (role === 'lead') {
      entry.dispose.push(scope.on('agent/request-error', (payload, next) => {
        if (payload.agent === agent && payload.provider === FUSION_PROVIDER) {
          const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
          try {
            const physicalPolicy = scope.llm.providerRetryPolicy(route.provider)
            const mutable = payload as { provider: string; retryPolicy?: ResolvedRetryPolicy }
            mutable.provider = route.provider
            mutable.retryPolicy = physicalPolicy
          } catch { /* preserve outer payload when the physical provider is unregistered */ }
        }
        return next()
      }, { prepend: true }))
    }
    entry.syncModel()
    entry.dispose.push(...this.callbacks.installTools(scope, agent, entry.binding, role, isToolAllowed))
    entry.ready = true
    entry.refreshTools()
  }

  /** Refresh stage tool restrictions before the next step's `tools.resolve()`. */
  refreshTools(agent: Agent): void {
    const entry = this.#entries.get(agent.id)
    if (entry?.agent !== agent || !entry.ready) return
    if (agent.ctx.fiber?.uid === null) {
      entry.ready = false
      this.#entries.delete(agent.id)
      return
    }
    try { entry.refreshTools() }
    catch (error) { entry.ready = false; throw error }
  }

  /** Sync a resident Worker's native model selection after a model-control route switch. */
  syncModel(agent: Agent): void {
    const entry = this.#entries.get(agent.id)
    if (entry?.agent !== agent || !entry.ready) return
    entry.syncModel()
  }

  /**
   * Caller owns quiescence and the original session-controller model selection.
   * Removing these listeners reveals that existing selection; it does not mutate
   * a request header or fabricate a replacement global default.
   */
  detach(agent: Agent): void {
    const entry = this.#entries.get(agent.id)
    if (!entry || entry.agent !== agent) return
    if (agent.status !== 'idle') throw new Error('Cannot detach Fusion while the native Agent is running')
    entry.ready = false
    for (const dispose of entry.dispose.reverse()) dispose()
    this.#entries.delete(agent.id)
  }
}
