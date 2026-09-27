import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { requestOutputReservation } from '../context/guard.js'
import type { PhysicalRoute, Role } from '../contracts.js'
import type { SessionBinding } from './bindings.js'
import { digestOf } from '../digest.js'

export interface FusionScopeCallbacks {
  route?(binding: SessionBinding, role: Role): PhysicalRoute
  beforeTurn?(agent: Agent, binding: SessionBinding, role: Role, turn: number): SessionBinding
  taskContext?(agent: Agent, binding: SessionBinding, role: Role): UserMessage | undefined
  beforeStep?(agent: Agent, binding: SessionBinding, role: Role): void
  projectMessage?(agent: Agent, binding: SessionBinding, role: Role, message: UserMessage): UserMessage
  /** All independent pause, budget, recovery and unknown-effect gates are checked here. */
  canAccess?(agent: Agent, binding: SessionBinding, role: Role): string | undefined
  /** Shared gates plus limits that apply only to admitting a new generation. */
  canRequest(agent: Agent, binding: SessionBinding, role: Role): string | undefined
  canExecute(exec: Readonly<ToolExecution>, binding: SessionBinding, role: Role): string | undefined
  beforeRequest(agent: Agent, turn: number, step: number, binding: SessionBinding, role: Role): void
  /** Disclosed context window for this physical model, read when the request is built. */
  modelLimits?(provider: string, model: string): Promise<{ contextWindow: number; defaultMaxTokens?: number; testedOutputCap?: number }>
  /** Read-stage tools, presented natively. Undefined restores the native composition. */
  readOnlyTools?(agent: Agent, binding: SessionBinding, role: Role): readonly string[] | undefined
  installTools(scope: Context, agent: Agent, binding: SessionBinding, role: Role): readonly (() => void)[]
}

interface ScopeEntry {
  readonly agent: Agent
  binding: SessionBinding
  readonly role: Role
  readonly dispose: (() => void)[]
  refreshTools(): void
  ready: boolean
}

/** Physical routing, prompt and tools live in the exact native Agent scope. */
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
      if (old.agent !== agent && old.agent.status === 'idle') this.detach(old.agent)
      else throw new Error('An existing Fusion scope must settle and detach before replacement')
    }
    const entry: ScopeEntry = { agent, binding: structuredClone(binding), role, dispose: [], ready: false, refreshTools: () => {} }
    this.#entries.set(agent.id, entry)
    const policy = entry.binding.profile.context[role]
    const scope = agent.ctx
    let readOnlyTools: readonly string[] | undefined
    let presentationKey: string | undefined
    const stageDisposers: (() => void)[] = []
    const clearStage = () => { for (const dispose of stageDisposers.splice(0).reverse()) dispose() }
    entry.dispose.push(clearStage)
    entry.refreshTools = () => {
      const tools = this.callbacks.readOnlyTools?.(agent, entry.binding, role)
      const key = JSON.stringify(tools ?? null)
      if (key === presentationKey) return
      clearStage()
      readOnlyTools = tools
      if (tools !== undefined) {
        // A Lead's capability ceiling is also used when validating a new child.
        // Only mask its prompt; restricting inheritance would disable Worker writes.
        if (role === 'worker') stageDisposers.push(scope.tools.restrict({ allow: tools }))
        stageDisposers.push(scope.tools.presentAs('native'))
      }
      presentationKey = key
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
        entry.refreshTools()
      } catch (error) { entry.ready = false; throw error }
    }))
    entry.dispose.push(scope.on('agent/pre-step', async (payload, next) => {
      if (payload.agent !== agent || !entry.ready || this.callbacks.canRequest(agent, entry.binding, role)) return { kind: 'reject' }
      this.callbacks.beforeStep?.(agent, entry.binding, role)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // Native compaction can run inside next(), after prompt assembly. Form
      // this user-role snapshot afterwards so the next request retains facts.
      const taskContext = this.callbacks.taskContext?.(agent, entry.binding, role)
      // Native selection compares the virtual menu route to the physical
      // request header. That is not a new model change on every Fusion step.
      return { ...decision, messages: [...decision.messages.filter(message => !(message.source?.kind === 'model-selection' && message.source.form === 'notice'
        && message.source.summary.endsWith('dsh-model-fusion/auto'))).map(message =>
        this.callbacks.projectMessage?.(agent, entry.binding, role, message) ?? message), ...(taskContext ? [taskContext] : [])] }
    }, { prepend: true }))
    entry.dispose.push(scope.systemPrompt.section({ name: 'fusion-role', order: 90, text: entry.binding.prompts[role] }))
    entry.dispose.push(scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
      entry.refreshTools()
      const assembled = await next()
      const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
      return { ...assembled, variables: { ...assembled.variables, provider: route.provider, model: route.model },
        // Native restrictions intentionally leave agent-local registrations
        // visible. Project only read-stage capabilities into this stage's
        // request; the deny-only guard still rejects hidden local tools.
        ...(readOnlyTools === undefined ? {} : { tools: assembled.tools.filter(tool => readOnlyTools?.includes(tool.name)
          || role === 'worker' && ['fusion_read_state', 'fusion_read_evidence', 'fusion_submit_result'].includes(tool.name)) }) }
    }, { prepend: true }))
    entry.dispose.push(scope.on('agent/request', async ({ agent: requesting, turn, step }, next) => {
      this.assertReady(requesting)
      const reason = this.callbacks.canRequest(requesting, entry.binding, role)
      if (reason) throw new Error(reason)
      const config = await next()
      const route = this.callbacks.route?.(entry.binding, role) ?? entry.binding.profile[role]
      this.callbacks.beforeRequest(agent, turn, step, entry.binding, role)
      const { reasoningEffort: _prior, ...rest } = config
      if (entry.binding.profile.interactionMode === 'model-like') {
        const { maxTokens, ...native } = rest
        return { ...native, ...(role === 'lead' && maxTokens !== undefined ? { maxTokens } : {}),
          provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) }
      }
      const disclosed = this.callbacks.modelLimits
        ? await this.callbacks.modelLimits(route.provider, route.model) : undefined
      // A new native child inherits its parent's creation maxTokens, whereas
      // a cold continuable activation deliberately does not persist that value.
      // The Worker is plugin-owned: resolve its own route allowance on both
      // paths. An explicit cap on the user-facing Lead still takes precedence.
      const requested = role === 'lead' ? config.maxTokens : undefined
      const maxTokens = disclosed
        ? requestOutputReservation(disclosed.contextWindow, requested, disclosed.defaultMaxTokens, disclosed.testedOutputCap, policy.reserveOutputTokens)
        : Math.min(requested ?? policy.reserveOutputTokens, policy.reserveOutputTokens)
      return { ...rest, provider: route.provider, model: route.model, maxTokens,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) }
    }, { prepend: true }))
    entry.refreshTools()
    entry.dispose.push(...this.callbacks.installTools(scope, agent, entry.binding, role))
    entry.ready = true
  }

  /** Refresh at the persisted state transition, before native prompt providers run. */
  refreshTools(agent: Agent): void {
    const entry = this.#entries.get(agent.id)
    if (entry?.agent !== agent || !entry.ready) return
    try { entry.refreshTools() }
    catch (error) { entry.ready = false; throw error }
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
