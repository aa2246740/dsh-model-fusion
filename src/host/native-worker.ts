import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type { PhysicalRoute } from '../contracts.js'

export interface NativeWorkerRequest {
  readonly childId: string
  readonly label: string
  /** Model-authored brief from the Lead's native tool call. */
  readonly brief: string
  readonly route: PhysicalRoute
  readonly persona: string
  readonly allowedTools: readonly string[]
}

export interface NativeWorkerAcceptance {
  readonly childId: string
  readonly messageId: MessageId
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
    const accepted = await this.ctx.subagents.startContinuable({
      provider: this.provider,
      label: request.label,
      childId: SessionId(request.childId),
      request: {
        parent,
        prompt: [{ type: 'text', text: request.brief }],
        persona: request.persona,
        agentOptions: {
          provider: request.route.provider,
          model: request.route.model,
          ...(request.route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.route.reasoningEffort) }),
        },
        toolFilter: { allow: [...request.allowedTools] },
        maxDepth: (parent.session.header.delegationDepth ?? 0) + 1,
      },
      signal,
    })
    if (accepted.childId !== request.childId) throw new Error('Native Worker identity changed during creation')
    return accepted
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
      if (!await this.ctx.sessions.flush(child.session)) throw new Error('Worker log persistence unavailable')
      this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0)
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
    if (!await this.ctx.sessions.flush(child.session)) throw new Error('Worker log persistence unavailable')
    this.#flushed.set(child, child.session.snapshotEvents().at(-1)?.seq ?? 0)
    return child
  }

  /** Native release owns quiescence, persistence and handle disposal across HMR. */
  async release(parent: Agent, childId: string): Promise<void> {
    const child = this.ctx.agents.get(SessionId(childId))
    if (child && child.session.header.parentSession !== parent.id) throw new Error('Cannot release another Lead’s child')
    await this.ctx.subagents.drainContinuableChildren(parent, [SessionId(childId)])
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
