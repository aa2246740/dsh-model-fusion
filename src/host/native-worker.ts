import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PhysicalRoute } from '../contracts.js'
import { requireSubagentMethod } from './subagent-seam.js'

export interface NativeWorkerRequest {
  readonly childId: string
  readonly label: string
  /** Model-authored brief from the Lead's native tool call. */
  readonly brief: string
  readonly route: PhysicalRoute
  /** 0.2.0 startContinuable persona. 0.2.1 rejects it; the role scope carries the prompt. */
  readonly persona: string
  /** 0.2.0 start-time tool ceiling. 0.2.1 rejects toolFilter; the role scope narrows tools. */
  readonly allowedTools: readonly string[]
}

export interface NativeWorkerAcceptance {
  readonly childId: string
  readonly messageId: MessageId
}

interface WorkerStartRequest {
  readonly parent: Agent
  readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
  readonly agentOptions: { readonly provider: string; readonly model: string; readonly reasoningEffort?: ReturnType<typeof ReasoningEffortId> }
  readonly maxDepth: number
  readonly persona?: string
  readonly toolFilter?: { readonly allow: readonly string[] }
}

interface StartedWorker {
  readonly childId: string
  readonly messageId?: MessageId
}

/** Structural view of the two DSH subagent seams. Only the branch that exists is called. */
interface SubagentSeam {
  startActivation?(spec: {
    readonly provider: string
    readonly label: string
    readonly childId: ReturnType<typeof SessionId>
    readonly delivery: 'parent'
    readonly request: WorkerStartRequest
    readonly signal: AbortSignal
  }): Promise<StartedWorker>
  startContinuable?(spec: {
    readonly provider: string
    readonly label: string
    readonly childId: ReturnType<typeof SessionId>
    readonly request: WorkerStartRequest
    readonly signal: AbortSignal
  }): Promise<StartedWorker>
  drainChildren?(parent: Agent, childIds: readonly ReturnType<typeof SessionId>[]): Promise<void>
  drainContinuableChildren?(parent: Agent, childIds: readonly ReturnType<typeof SessionId>[]): Promise<void>
}

/** Version-pinned public API adapter. It never calls an LLM adapter or runs a shell itself. */
export class NativeWorkerTransport {
  readonly #flushed = new WeakMap<Agent, number>()
  constructor(private readonly ctx: Context, private readonly provider = 'spawn') {}

  assertAvailable(): void {
    const provider = this.ctx.subagents.getProvider(this.provider)
    if (!provider?.prepareContinuable || provider.inheritsParentContext !== false) {
      throw new Error(`Fusion requires an independent continuable provider: ${this.provider}`)
    }
  }

  /** Caller durably reserves the child and operation before entering this method. */
  async start(parent: Agent, request: NativeWorkerRequest, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    this.assertAvailable()
    signal.throwIfAborted()
    if (this.ctx.agents.get(SessionId(request.childId))) throw new Error('Reserved Worker already exists; reconcile before retrying')
    const prompt = [{ type: 'text' as const, text: request.brief }]
    const agentOptions = {
      provider: request.route.provider,
      model: request.route.model,
      ...(request.route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.route.reasoningEffort) }),
    }
    const maxDepth = (parent.session.header.delegationDepth ?? 0) + 1
    const childId = SessionId(request.childId)
    // `startActivation` is the 0.2.1 name. `delivery: 'parent'` keeps the 0.2.0
    // settlement: it reaches the Lead's inbox, which this transport reconciles
    // from the session log. 0.2.1 rejects `persona` and `toolFilter`; the
    // `fusion-role` section and NativeFusionScopes own both, and the scope is
    // installed at `agent/created` before the child's first request.
    // Otherwise this is 0.2.0 `startContinuable`, persona and toolFilter included.
    const subagents = this.ctx.subagents as SubagentSeam
    const start = requireSubagentMethod(subagents, 'startActivation', 'startContinuable')
    const accepted = start === 'startActivation'
      ? await subagents.startActivation!({
        provider: this.provider, label: request.label, childId, delivery: 'parent',
        request: { parent, prompt, agentOptions, maxDepth }, signal,
      })
      : await subagents.startContinuable!({
        provider: this.provider, label: request.label, childId,
        request: { parent, prompt, persona: request.persona, agentOptions, toolFilter: { allow: [...request.allowedTools] }, maxDepth },
        signal,
      })
    if (accepted.childId !== request.childId) throw new Error('Native Worker identity changed during creation')
    if (!accepted.messageId) throw new Error('Native Worker start did not accept an initial message')
    return { childId: accepted.childId, messageId: accepted.messageId }
  }

  /** Only Lead-authored feedback is sent through this public model-message API. */
  async continue(parent: Agent, childId: string, feedback: string, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    signal.throwIfAborted()
    const messageId = await this.ctx.subagents.sendMessage(
      parent, SessionId(childId), [{ type: 'text', text: feedback }], { signal },
    )
    return { childId, messageId }
  }

  /**
   * Replace an in-flight generation through public cancellation, then deliver
   * to the same durable child. The caller must first exclude live/unknown
   * effectful tools. Otherwise use continue(), which steers at a step boundary.
   */
  async interruptAndContinue(parent: Agent, childId: string, feedback: string, signal: AbortSignal): Promise<NativeWorkerAcceptance> {
    signal.throwIfAborted()
    await this.stop(parent, childId)
    signal.throwIfAborted()
    return this.continue(parent, childId, feedback, signal)
  }

  /** Interrupt acceptance is insufficient: wait for the exact native Agent to settle and flush. */
  settle(parent: Agent, childId: string, signal: AbortSignal): Promise<Agent>
  /** Yield a blocking tool to native user steering without canceling or releasing the Worker. */
  settle(parent: Agent, childId: string, signal: AbortSignal, yieldToSteering: true): Promise<Agent | undefined>
  async settle(parent: Agent, childId: string, signal: AbortSignal, yieldToSteering = false): Promise<Agent | undefined> {
    const child = this.#requireChild(parent, childId)
    let interruptError: unknown
    let removeSteering = () => {}
    const interrupt = () => {
      try { this.ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent }) }
      catch (error) { interruptError = error }
    }
    signal.addEventListener('abort', interrupt, { once: true })
    if (signal.aborted) interrupt()
    try {
      if (yieldToSteering && !signal.aborted) {
        const steering = new Promise<true>(resolve => {
          const check = () => {
            // Queue/next-turn and plugin context keep their native semantics.
            if (parent.inbox.nextStep.some(message => message.source.kind === 'user')) resolve(true)
          }
          removeSteering = parent.ctx.on('agent/inbox/inserted', ({ agent }) => { if (agent === parent) check() })
          check() // A message may already have arrived during delegation setup.
        })
        const yielded = await Promise.race([child.whenIdle().then(() => false), steering])
        // Cancellation still owns full settlement; an already idle Worker can
        // be flushed normally. The Lead alone authors any revised Worker brief.
        if (yielded && !signal.aborted && child.status !== 'idle') return undefined
      }
      await child.whenIdle()
      if (interruptError) throw interruptError
      if (this.ctx.agents.get(child.id) !== child) throw new Error('Worker residency changed; quiescence requires reconciliation')
      await this.#flushSettled(child)
      return child
    } finally { removeSteering(); signal.removeEventListener('abort', interrupt) }
  }

  async stop(parent: Agent, childId: string): Promise<Agent> {
    const child = this.#requireChild(parent, childId)
    // Native continuation teardown may already be closing this idle handle.
    // Reuse only our exact prior quiescence+flush proof at the unchanged log seq.
    if (child.status === 'idle' && this.#flushed.get(child) === (child.session.snapshotEvents().at(-1)?.seq ?? 0)) return child
    this.ctx.subagents.interrupt(child.id, { kind: 'ancestor', agent: parent })
    await child.whenIdle()
    if (this.ctx.agents.get(child.id) !== child) throw new Error('Worker residency changed during stop')
    await this.#flushSettled(child)
    return child
  }

  /**
   * 0.2.1 natural settlement flushes the child, then closes the persistence
   * handle. A stop that loses that race must not treat the closed handle as a
   * lost log. Any other flush failure still means the log is not durable.
   */
  async #flushSettled(child: Agent): Promise<void> {
    try {
      if (!await this.ctx.sessions.flush(child.session)) throw new Error('Worker log persistence unavailable')
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'SessionHandleClosedError') throw error
      return
    }
    this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0)
  }

  /** Native release owns quiescence, persistence and handle disposal across HMR. */
  async release(parent: Agent, childId: string): Promise<void> {
    const child = this.ctx.agents.get(SessionId(childId))
    if (child && child.session.header.parentSession !== parent.id) throw new Error('Cannot release another Lead’s child')
    // 0.2.1 calls this `drainChildren`. 0.2.0 calls it `drainContinuableChildren`.
    const subagents = this.ctx.subagents as SubagentSeam
    const drain = requireSubagentMethod(subagents, 'drainChildren', 'drainContinuableChildren')
    const ids = [SessionId(childId)]
    if (drain === 'drainChildren') await subagents.drainChildren!(parent, ids)
    else await subagents.drainContinuableChildren!(parent, ids)
    if (this.ctx.agents.get(SessionId(childId))) throw new Error('Native Worker release did not prove absence')
  }

  #requireChild(parent: Agent, childId: string): Agent {
    const child = this.ctx.agents.get(SessionId(childId))
    if (!child || child.session.header.parentSession !== parent.id) {
      throw new Error('Worker is absent or is not this Lead’s child; reconcile its persisted session')
    }
    return child
  }
}
