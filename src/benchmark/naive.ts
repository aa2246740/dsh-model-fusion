import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PairProfile } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { isShellTool, nativeShellTool } from '../host/shell.js'

/** A declared benchmark treatment, never installed in product sessions. */
export const naivePrompts = {
  lead: 'Complete the user task. You may work directly or use naive_delegate for a bounded implementation or test task. Every delegation starts a fresh independent Worker, which sees only your brief and the shared workspace. Include the relevant requirements and constraints in that brief. Inspect the returned result, correct defects or delegate again as needed, and run relevant tests before finishing. Delegation and direct commands run sequentially under the same total allowance.',
  worker: 'Complete the delegated task using the native tools. Inspect the code, implement the requested changes and run relevant tests. Preserve existing acceptance tests. Return a concise account of changes, verification and unresolved limitations. This is a fresh independent session; you have no earlier Worker conversation.',
}

export interface NaiveDelegation {
  ordinal: number
  callId: string
  briefDigest: string
  startedAt: string
  endedAt: string | null
  childSessionId: string | null
  parentSessionId: string
  state: 'starting' | 'running' | 'settled' | 'failed'
  stopReason: string | null
  disposed: boolean
  failure: string | null
}

/** Simple sequential coordinator using the native one-shot child lifecycle. */
export class NaiveCoordinator {
  readonly delegations: NaiveDelegation[] = []
  readonly #dispose: (() => void)[] = []
  readonly #operations = new Set<Promise<string>>()
  readonly #controllers = new Set<AbortController>()
  #delegating = false
  #writer: symbol | undefined
  #closed = false
  #cleanupFailure: unknown

  constructor(readonly ctx: Context, readonly parent: Agent, readonly store: SqliteFusionStore,
    readonly profile: PairProfile, readonly workerMaxTokens: number, readonly tools: readonly string[] = [nativeShellTool]) {
    const provider = ctx.subagents.getProvider('spawn')
    if (!provider || provider.inheritsParentContext !== false) throw new Error('Naive requires a fresh-context native spawn provider')
    this.#dispose.push(parent.ctx.systemPrompt.section({ name: 'naive-benchmark', order: 90, text: naivePrompts.lead }))
    // Deny overlap even if an external caller bypasses the native sibling
    // scheduler. The declared tool remains exclusive under that scheduler.
    this.#dispose.push(ctx.on('tools/execute', async (exec, next) => {
      if (!exec.agent || !this.owns(exec.agent)) return next()
      this.assertReady()
      if (!isShellTool(exec.name)) return next()
      if (this.#writer || this.#delegating && exec.agent === parent) throw new Error('Naive requires one native writer at a time')
      this.#writer = exec.token
      try { return await next() }
      finally { if (this.#writer === exec.token) this.#writer = undefined }
    }, { prepend: true }))
    this.#dispose.push(parent.ctx.tools.register(defineTool({
      name: 'naive_delegate',
      description: 'Run one fresh independent Worker on a complete task brief. Wait for its result and dispose it. A subsequent delegation starts a new Worker without prior chat history. Use sequentially with other tools.',
      parameters: { brief: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async (args, exec) => {
        if (exec.agent !== parent || this.#closed || this.#delegating || this.#writer) throw new Error('Naive delegation requires an idle exclusive Lead tool slot')
        const operation = this.#delegate(args.brief, exec.callId, exec.signal)
        this.#operations.add(operation)
        try { return await operation }
        finally { this.#operations.delete(operation) }
      },
    })))
  }

  owns(agent: Agent): boolean {
    return agent === this.parent || agent.session.header.parentSession === this.parent.id
  }

  assertReady(): void {
    if (this.#closed) throw new Error('Naive benchmark is closing')
    if (this.#cleanupFailure) throw new Error(`Naive recording or cleanup failed: ${String(this.#cleanupFailure)}`)
  }

  async #delegate(brief: string, callId: string, signal: AbortSignal): Promise<string> {
    if (!brief.trim()) throw new Error('A nonempty Worker brief is required')
    signal.throwIfAborted()
    this.#delegating = true
    const controller = new AbortController()
    this.#controllers.add(controller)
    const row: NaiveDelegation = { ordinal: this.delegations.length + 1, callId, briefDigest: digestOf(brief),
      startedAt: new Date().toISOString(), endedAt: null, childSessionId: null, parentSessionId: this.parent.id,
      state: 'starting', stopReason: null, disposed: false, failure: null }
    this.delegations.push(row)
    const key = `naive-delegation:${this.parent.id}:${row.ordinal}`
    let revision = 0, run: SubagentRun | undefined
    const persist = () => { revision = this.store.writeDocument(key, revision, { ...row }) }
    try {
      persist()
      const route = this.profile.worker
      run = await this.ctx.subagents.start('spawn', { parent: this.parent, label: `Naive Worker ${row.ordinal}`,
        prompt: [{ type: 'text', text: brief }], persona: naivePrompts.worker,
        signal: AbortSignal.any([signal, controller.signal]),
        agentOptions: { provider: route.provider, model: route.model,
          ...(route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}),
          maxTokens: this.workerMaxTokens },
        toolFilter: { allow: [...this.tools] }, maxDepth: (this.parent.session.header.delegationDepth ?? 0) + 1 })
      // A later validation/journal failure still owns disposal. Observe an
      // infrastructure rejection immediately, before those checks can throw;
      // the normal await below retains the actual rejection as the outcome.
      void run.result.catch(() => undefined)
      if (!run.localAgent || run.localAgent.session.header.parentSession !== this.parent.id) throw new Error('Naive requires an owned native child')
      if (this.delegations.some(other => other !== row && other.childSessionId === run!.id)) throw new Error('Naive child identity was reused')
      row.childSessionId = run.id
      row.state = 'running'
      persist()
      const result = await run.result
      row.stopReason = result.stopReason
      row.state = 'settled'
      persist()
      if (result.stopReason !== 'completed') throw new Error(`Naive Worker ended ${result.stopReason}; its output is incomplete`)
      return JSON.stringify({ childSessionId: run.id, stopReason: result.stopReason, output: result.output })
    } catch (error) {
      row.state = 'failed'
      row.failure = String(error)
      throw error
    } finally {
      try {
        if (run) {
          await run.dispose()
          if (this.ctx.agents.get(run.id)) throw new Error('Naive child remained resident after disposal')
          row.disposed = true
        }
        row.endedAt = new Date().toISOString()
        persist()
      } catch (error) { this.#cleanupFailure = error; throw error }
      finally { this.#controllers.delete(controller); this.#delegating = false }
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const controller of this.#controllers) controller.abort(new Error('Naive benchmark closing'))
    await Promise.allSettled([...this.#operations])
    for (const dispose of this.#dispose.reverse()) dispose()
    if (this.#cleanupFailure) throw this.#cleanupFailure
    if (this.#writer || this.#delegating || this.delegations.some(row => row.childSessionId && !row.disposed)) {
      throw new Error('Naive child/tool quiescence unproven')
    }
  }
}
