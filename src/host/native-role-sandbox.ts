import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Role } from '../contracts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'

// Mirrors the Host sandbox-policy augmentation (a type-only declaration; the Host
// registers the event at runtime). The plugin does not depend on that package.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'sandbox/mode': { mode: Mode; source?: 'delegation' }
  }
}

/** The public per-session policy service (`ctx.sandboxPolicy`), used by structure only. */
interface SandboxPolicy {
  resolve(request?: { session?: Session }): { mode: Mode }
  overrideOf(session: Session): Mode | undefined
}

interface Intent {
  schemaVersion: 1
  sessionId: string
  /** The mode the user chose for this conversation; the Sidekick runs under it. */
  mode: Mode
  /** `sandbox/mode` events this plugin appended; any other one is the user's choice. */
  ownSeqs: number[]
  /** False after leaving Fusion; the next selection re-reads the user's current mode. */
  active: boolean
}

export const roleSeparated = (binding: SessionBinding) => binding.profile.workflowPolicy === 'enforced-v3'

/**
 * Role separation enforced below the prompt: the Lead's session runs under the
 * Host's own read-only sandbox (bash and filesystem are refused by the OS
 * backend), while the Sidekick keeps the mode the user chose. The plugin never
 * widens a mode: the Sidekick gets exactly the user's mode, and leaving Fusion
 * restores it on the conversation. Only public session events are written.
 */
export class NativeRoleSandbox {
  readonly #dispose: (() => void)[] = []

  constructor(readonly ctx: Context, readonly store: SqliteFusionStore,
    readonly binding: (sessionId: string) => SessionBinding | undefined) {}

  get #policy(): SandboxPolicy | undefined {
    return (this.ctx as unknown as { get(name: string): unknown }).get('sandboxPolicy') as SandboxPolicy | undefined
  }

  #id(sessionId: string) { return `sandbox-intent:${sessionId}` }
  #intent(sessionId: string): Intent | undefined {
    return this.store.readDocument(this.#id(sessionId))?.value as Intent | undefined
  }
  #save(intent: Intent) {
    const prior = this.store.readDocument(this.#id(intent.sessionId))
    this.store.writeDocument(this.#id(intent.sessionId), prior?.revision ?? 0, { ...intent, ownSeqs: intent.ownSeqs.slice(-32) })
  }
  // Session listeners run synchronously inside append, before the seq is known here.
  #writing = false
  #set(session: Session, mode: Mode, intent: Intent) {
    this.#writing = true
    try { intent.ownSeqs.push(session.append('sandbox/mode', { mode }).seq) }
    finally { this.#writing = false }
  }

  /**
   * Called before every model request of an enforced-v3 role. `writer` is true only while the Lead holds the
   * write lease through a Host-unlocked takeover; it then runs under the user's own mode, like the Sidekick.
   */
  ensure(agent: Agent, binding: SessionBinding, role: Role, writer = false): void {
    const policy = this.#policy
    if (!policy || !roleSeparated(binding)) return
    if (role === 'lead') {
      const saved = this.#intent(binding.sessionId)
      const intent: Intent = saved?.active ? saved
        : { schemaVersion: 1, sessionId: binding.sessionId, mode: policy.resolve({ session: agent.session }).mode, ownSeqs: saved?.ownSeqs ?? [], active: true }
      const target = writer ? intent.mode : 'read-only'
      if (policy.overrideOf(agent.session) !== target) this.#set(agent.session, target, intent)
      this.#save(intent)
      return
    }
    const intent = this.#intent(binding.sessionId)
    if (!intent?.active) throw new Error('Fusion has not recorded the conversation sandbox mode for the Sidekick')
    // The child was seeded with the Lead's read-only override at delegation; give it the user's mode.
    if (policy.overrideOf(agent.session) !== intent.mode) this.#set(agent.session, intent.mode, { ...intent, ownSeqs: [] })
  }

  /**
   * Frozen acceptance checks are plugin-issued and nested in a Lead tool call, so
   * they would inherit the Lead's read-only session. They run under the user's
   * mode; the Lead's own shell stays refused meanwhile because leadShellProblem
   * requires an actual read-only resolution at execution time.
   */
  async whileChecking<T>(agent: Agent, binding: SessionBinding, run: () => Promise<T>): Promise<T> {
    const policy = this.#policy, intent = this.#intent(binding.sessionId)
    if (!policy || !roleSeparated(binding) || !intent?.active || intent.mode === 'read-only') return run()
    this.#set(agent.session, intent.mode, intent)
    this.#save(intent)
    try { return await run() }
    finally {
      const current = this.#intent(binding.sessionId) ?? intent
      this.#set(agent.session, 'read-only', current)
      this.#save(current)
    }
  }

  /** A Lead shell is allowed only when the Host will actually run it read-only and without escalation. */
  leadShellProblem(exec: Readonly<ToolExecution>): string | undefined {
    const policy = this.#policy
    if (!policy) return 'FUSION_LEAD_READ_ONLY: this Host exposes no sandbox policy, so the Lead cannot run shell commands. Delegate commands to the Sidekick.'
    const args = (exec.arguments ?? {}) as { sandbox_permissions?: unknown }
    if (args.sandbox_permissions !== undefined && args.sandbox_permissions !== null && args.sandbox_permissions !== '') {
      return 'FUSION_LEAD_READ_ONLY: the Lead never escalates its sandbox. Delegate anything that needs to write or run with wider access to the Sidekick with fusion_delegate.'
    }
    if (policy.resolve({ session: exec.agent!.session }).mode !== 'read-only') {
      return 'FUSION_LEAD_READ_ONLY: the Lead shell is not currently confined to read-only; delegate this command to the Sidekick.'
    }
    return undefined
  }

  /** Put the user's own mode back when the conversation leaves Fusion. */
  restore(agent: Agent): void {
    const intent = this.#intent(agent.id), policy = this.#policy
    if (!intent?.active || !policy) return
    if (policy.overrideOf(agent.session) !== intent.mode) this.#set(agent.session, intent.mode, intent)
    this.#save({ ...intent, active: false })
  }

  /** A mode switch the user makes while Fusion is selected becomes the Sidekick's mode; the Lead stays read-only. */
  install(): () => void {
    this.#dispose.push(this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode' || this.#writing) return
      const binding = this.binding(session.id)
      if (!binding?.selected || !roleSeparated(binding) || binding.sessionId !== session.id) return
      const intent = this.#intent(session.id)
      if (!intent?.active || intent.ownSeqs.includes(event.seq)) return
      intent.mode = (event.data as { mode: Mode }).mode
      // Appending inside this event's publication is rejected as reentrant; re-confine next tick.
      setImmediate(() => {
        try {
          const current = this.#intent(session.id)
          if (!current?.active) return
          this.#set(session, 'read-only', current)
          this.#save(current)
        } catch { /* the next Lead request re-confines through ensure() */ }
      })
      this.#save(intent)
    }))
    return () => { for (const dispose of this.#dispose.splice(0)) dispose() }
  }
}
