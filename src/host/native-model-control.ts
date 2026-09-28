import { bi } from '../bilingual.js'
import { digestOf } from '../digest.js'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PhysicalRoute, Role } from '../contracts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { BindingRepository, type SessionBinding } from './bindings.js'
import { adaptiveWorkflow, enforcedWorkflow } from './native-workflow.js'
import { isShellTool } from './shell.js'

const LEAD_RECOVERABLE = ['WORKFLOW_INCOMPLETE', 'NO_PROGRESS', 'UNKNOWN']
const LEAD_RECOVERIES = 2

export interface ModelControl {
  schemaVersion: 1
  sessionId: string
  profileDigest: string
  epoch: number
  recoveryEpoch?: number
  /** Lead-cleared recoverable Worker waits for the current task (bounded). */
  leadRecoveries?: { taskId: string; count: number }
  routes: Record<Role, PhysicalRoute>
  waits: Partial<Record<Role, { taskId: string; code: string; at: string; retryNotBefore?: string; quotaResetAt: null }>>
  operation?: { id: string; taskId: string; state: 'prepared' | 'dispatching' | 'delivered' | 'failed'; message?: UserMessage; error?: string }
  schedule?: { id: string; taskId: string; epoch: number; dueAt: string; userSeq: number; state: 'scheduled' | 'cancelled' | 'fired' | 'failed'; reason?: string }
}
export interface ControlView extends ModelControl { revision: number }
export function readModelControl(store: SqliteFusionStore, binding: SessionBinding): ControlView | undefined {
  if (binding.profile.interactionMode !== 'model-like') return undefined
  const row = store.readDocument(`model-control:${binding.sessionId}`)
  if (!row) return { schemaVersion: 1, revision: 0, sessionId: binding.sessionId, profileDigest: binding.profile.digest,
    epoch: 0, routes: { lead: binding.profile.lead, worker: binding.profile.worker }, waits: {} }
  const value = row.value as ModelControl
  if (value.schemaVersion !== 1 || value.sessionId !== binding.sessionId || value.profileDigest !== binding.profile.digest
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !value.routes?.lead || !value.routes.worker || !value.waits) {
    throw new Error('Fusion model control requires reconciliation')
  }
  return { ...value, revision: row.revision }
}

interface Callbacks {
  owner(agent: Agent): { binding: SessionBinding; role: Role } | undefined
  resolve(sessionId: string): Promise<Agent>
  pause(agent: Agent): Promise<void>
  resume(agent: Agent): Promise<void>
  settled(binding: SessionBinding): boolean
  stopAuxiliary(binding: SessionBinding): void
}

/** Durable local controls. No provider polling, synthetic user identity, or silent routing fallback. */
export class NativeModelControl {
  readonly #bindings: BindingRepository
  readonly #locks = new Set<string>()
  readonly #pending = new Set<Promise<void>>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #dispose: (() => void)[] = []
  #closed = false
  constructor(readonly ctx: Context, readonly store: SqliteFusionStore, readonly callbacks: Callbacks) {
    this.#bindings = new BindingRepository(store)
    this.#dispose.push(ctx.on('agent/request-error', async (payload, next) => {
      const owner = callbacks.owner(payload.agent)
      if (owner?.binding.profile.interactionMode !== 'model-like') return next()
      const quota = ['QUOTA', 'QUOTA_EXHAUSTED', 'INSUFFICIENT_QUOTA', 'USAGE_LIMIT_REACHED'].includes(payload.failure.code)
      if (!quota) {
        const action = await next()
        if (!action && !payload.signal.aborted) this.failure(owner.binding, owner.role, payload.failure)
        return action
      }
      this.failure(owner.binding, owner.role, payload.failure)
      payload.agent.cancel({ kind: 'hook', reason: 'Fusion provider quota requires local continuation' }, { keepInbox: true })
      return undefined
    }, { prepend: true }))
    this.#dispose.push(ctx.on('session/event', (session, event) => {
      const user = event.type === 'user/message' ? !event.data.source || event.data.source.kind === 'user'
        : event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => !message.source || message.source.kind === 'user')
      if (!user) return
      const binding = this.#bindings.read(session.id)?.binding
      if (!binding?.selected || binding.profile.interactionMode !== 'model-like') return
      let view = readModelControl(store, binding)!
      if (view.schedule?.state === 'scheduled' && event.seq > view.schedule.userSeq) this.cancel(binding, bi('新的用户消息已取消定时继续', 'A new user message cancelled the scheduled continuation'))
      view = readModelControl(store, binding)!
      if (adaptiveWorkflow(binding) && Object.values(view.waits).some(wait => wait?.taskId === binding.taskId
        && ['NO_PROGRESS', 'WORKFLOW_INCOMPLETE'].includes(wait.code))) {
        this.write({ ...view, recoveryEpoch: (view.recoveryEpoch ?? 0) + 1,
          waits: Object.fromEntries(Object.entries(view.waits).filter(([, wait]) => wait?.taskId !== binding.taskId
            || !['NO_PROGRESS', 'WORKFLOW_INCOMPLETE'].includes(wait.code))) })
      }
    }))
    this.#dispose.push(ctx.on('tools/result', (exec, result) => {
      const owner = exec.agent && callbacks.owner(exec.agent)
      if (owner?.binding.profile.interactionMode !== 'model-like') return undefined
      if (enforcedWorkflow(owner.binding)) return undefined
      const id = `progress:${owner.binding.taskId}:${exec.agent!.id}`, row = store.readDocument(id)
      const prior = row?.value as { fingerprint?: string; count?: number } | undefined
      const shell = isShellTool(exec.name) && !result.isError ? result.value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } : undefined
      const failedShell = typeof shell?.exitCode === 'number' && shell.exitCode !== 0
      const fingerprint = result.isError || failedShell ? digestOf({ name: exec.name, args: exec.arguments,
        outcome: failedShell ? { exitCode: shell!.exitCode, stdout: shell!.stdout, stderr: shell!.stderr } : result.content }) : undefined
      const count = fingerprint && fingerprint === prior?.fingerprint ? (prior.count ?? 0) + 1 : fingerprint ? 1 : 0
      store.writeDocument(id, row?.revision ?? 0, { fingerprint, count })
      if (count >= 3) this.failure(owner.binding, owner.role, { code: 'NO_PROGRESS', message: 'Three unchanged failed tool attempts; a changed approach is required' })
      return undefined
    }))
    for (const binding of this.#bindings.selected()) this.arm(binding)
  }
  reset(binding: SessionBinding) {
    if (binding.profile.interactionMode !== 'model-like') return
    const id = `model-control:${binding.sessionId}`, row = this.store.readDocument(id)
    this.store.writeDocument(id, row?.revision ?? 0, { schemaVersion: 1, sessionId: binding.sessionId,
      profileDigest: binding.profile.digest, epoch: 0, routes: { lead: binding.profile.lead, worker: binding.profile.worker }, waits: {} })
  }
  write(view: ControlView) {
    const { revision, ...value } = view
    return this.store.writeDocument(`model-control:${view.sessionId}`, revision, value)
  }
  route(binding: SessionBinding, role: Role): PhysicalRoute { return readModelControl(this.store, binding)?.routes[role] ?? binding.profile[role] }
  waiting(binding: SessionBinding, role: Role) {
    const wait = readModelControl(this.store, binding)?.waits[role]
    return wait?.taskId === binding.taskId ? wait : undefined
  }
  /**
   * Clear a role wait the Lead can resolve itself by sending a new instruction: a missing report or
   * transition (WORKFLOW_INCOMPLETE), a repeated unchanged result (NO_PROGRESS) or an unclassified
   * error (UNKNOWN). At most LEAD_RECOVERIES per task; quota and credential stops are never cleared here.
   */
  leadRecover(binding: SessionBinding, role: Role): boolean {
    const view = readModelControl(this.store, binding)
    const wait = view?.waits[role]
    if (!view || !wait || wait.taskId !== binding.taskId || !LEAD_RECOVERABLE.includes(wait.code)) return false
    const used = view.leadRecoveries?.taskId === binding.taskId ? view.leadRecoveries.count : 0
    if (used >= LEAD_RECOVERIES) return false
    const { [role]: _cleared, ...waits } = view.waits
    this.write({ ...view, waits, recoveryEpoch: (view.recoveryEpoch ?? 0) + 1, leadRecoveries: { taskId: binding.taskId, count: used + 1 } })
    return true
  }
  /** The role stalled again after the Lead already redirected it LEAD_RECOVERIES times this task. */
  recoveriesExhausted(binding: SessionBinding, role: Role): boolean {
    const view = readModelControl(this.store, binding), wait = view?.waits[role]
    if (!view || !wait || wait.taskId !== binding.taskId || !LEAD_RECOVERABLE.includes(wait.code)) return false
    return (view.leadRecoveries?.taskId === binding.taskId ? view.leadRecoveries.count : 0) >= LEAD_RECOVERIES
  }
  blocked(binding: SessionBinding, role: Role): string | undefined {
    const view = readModelControl(this.store, binding)
    if (view?.operation && ['prepared', 'dispatching'].includes(view.operation.state)) return 'Fusion continuation is pending local delivery confirmation'
    return view?.waits[role]?.taskId === binding.taskId ? `${role} is paused (${view.waits[role]!.code}); use local Fusion controls to continue` : undefined
  }
  reconcileDelivery(agent: Agent, binding: SessionBinding, evidenceId: string) {
    const view = readModelControl(this.store, binding), operation = view?.operation
    if (!view || !operation || !['prepared', 'dispatching'].includes(operation.state)) return
    const delivered = operation.message && agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === operation.message!.id))
    this.write({ ...view, operation: { ...operation, state: delivered ? 'delivered' : 'failed',
      error: `Delivery inspected; evidence ${evidenceId}. No automatic replay.` } })
  }
  failure(binding: SessionBinding, role: Role, failure: LlmFailure) {
    const view = readModelControl(this.store, binding)!
    const ms = failure.providerRetryAfterMs
    this.write({ ...view, waits: { ...view.waits, [role]: { taskId: binding.taskId, code: failure.code,
      at: new Date().toISOString(), quotaResetAt: null,
      ...(ms !== undefined && Number.isFinite(ms) && ms >= 0 && ms < 8.64e15 - Date.now()
        ? { retryNotBefore: new Date(Date.now() + ms).toISOString() } : {}) } },
      ...(view.schedule ? { schedule: { ...view.schedule, state: 'cancelled', reason: bi('模型仍不可用；不会重复自动请求', 'The model is still unavailable; no further automatic request') } } : {}) })
    this.callbacks.stopAuxiliary(binding)
    this.clearTimer(binding.sessionId)
  }
  private require(sessionId: string, taskId: string, revision: number) {
    const saved = this.#bindings.read(sessionId)
    if (!saved?.binding.selected || saved.binding.taskId !== taskId) throw new Error(bi('任务已变化，请刷新状态', 'The task changed; refresh the status'))
    const view = readModelControl(this.store, saved.binding)
    if (!view || view.revision !== revision) throw new Error(bi('恢复状态已变化，请刷新后重试', 'The recovery state changed; refresh and retry'))
    if (this.store.load(saved.binding.taskId)?.control.mode === 'completed') throw new Error(bi('任务已经完成', 'The task is already finished'))
    return { binding: saved.binding, view, bindingRevision: saved.revision }
  }
  private userSeq(agent: Agent) { return agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && (!event.data.source || event.data.source.kind === 'user') || event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => !message.source || message.source.kind === 'user'))?.seq ?? 0 }
  cancel(binding: SessionBinding, reason = bi('已取消定时继续', 'Scheduled continuation cancelled')) {
    const view = readModelControl(this.store, binding)
    if (view?.schedule?.state === 'scheduled') this.write({ ...view, schedule: { ...view.schedule, state: 'cancelled', reason } })
    this.clearTimer(binding.sessionId)
  }
  async schedule(sessionId: string, taskId: string, revision: number, dueAt: string) {
    const time = Date.parse(dueAt)
    if (!Number.isFinite(time) || time <= Date.now()) throw new Error(bi('请选择未来的继续时间', 'Choose a time in the future'))
    const { binding } = this.require(sessionId, taskId, revision)
    const agent = await this.callbacks.resolve(sessionId)
    const { view } = this.require(sessionId, taskId, revision)
    if (agent.status !== 'idle' || !this.callbacks.settled(binding)) throw new Error(bi('等待当前操作停止并核对结果后再设置定时继续', 'Wait for the current operation to stop and check it before scheduling'))
    if (view.operation && ['prepared', 'dispatching'].includes(view.operation.state)) throw new Error(bi('请先检查上次继续操作的投递结果', 'Check the delivery of the last continuation first'))
    if (!Object.values(view.waits).some(wait => wait?.taskId === taskId)) throw new Error(bi('只有等待模型恢复的任务可以定时继续', 'Only a task waiting for its model can be scheduled'))
    this.write({ ...view, schedule: { id: randomUUID(), taskId, epoch: view.epoch, dueAt: new Date(time).toISOString(),
      userSeq: this.userSeq(agent), state: 'scheduled' } })
    this.arm(binding)
  }
  continue(sessionId: string, taskId: string, revision: number, change?: { role: Role; route: PhysicalRoute }, scheduledId?: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Fusion runtime is closing'))
    const pending = this.runContinue(sessionId, taskId, revision, change, scheduledId)
    this.#pending.add(pending)
    void pending.finally(() => this.#pending.delete(pending)).catch(() => undefined)
    return pending
  }
  private async runContinue(sessionId: string, taskId: string, revision: number, change?: { role: Role; route: PhysicalRoute }, scheduledId?: string) {
    if (this.#locks.has(sessionId)) throw new Error(bi('当前会话正在恢复，请稍候', 'This conversation is recovering; please wait'))
    this.#locks.add(sessionId)
    try {
      const initial = this.require(sessionId, taskId, revision)
      const agent = await this.callbacks.resolve(sessionId)
      const userSeq = this.userSeq(agent)
      let { view, binding } = this.require(sessionId, taskId, revision)
      if (view.operation && ['prepared', 'dispatching'].includes(view.operation.state)) {
        const messageId = view.operation.message?.id
        const delivered = messageId && agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === messageId))
        if (delivered) { this.write({ ...view, operation: { ...view.operation, state: 'delivered' } }); return }
        throw new Error(bi('上次继续操作的投递结果未知；请检查会话，不会自动重复发送', 'Delivery of the last continuation is unknown; check the conversation. Nothing is resent automatically'))
      }
      if (scheduledId && (view.schedule?.id !== scheduledId || view.schedule.state !== 'scheduled'
        || view.schedule.epoch !== view.epoch || view.schedule.userSeq !== userSeq || agent.status !== 'idle')) {
        this.cancel(binding, bi('任务状态已变化，定时继续已取消', 'The task changed; the scheduled continuation was cancelled')); return
      }
      // Native pause drains both agents and native effects before committing a route.
      await this.callbacks.pause(agent)
      const current = this.#bindings.read(sessionId)
      if (current?.revision !== initial.bindingRevision || this.userSeq(agent) !== userSeq) throw new Error(bi('暂停期间任务或用户消息已变化，请刷新', 'The task or messages changed while paused; refresh'))
      ;({ view, binding } = this.require(sessionId, taskId, revision))
      if (!this.callbacks.settled(binding)) throw new Error(bi('中断的操作尚未确认结束，请先使用 /fusion recover 核对', 'Interrupted operations are not confirmed finished; use /fusion recover first'))
      const operation = { id: randomUUID(), taskId, state: 'prepared' as const }
      const message = createUserMessage({ content: [{ type: 'text', text: `Continue the existing Fusion task ${taskId} from its saved state. Read fusion_read_state if needed. Preserve accepted constraints and inspect uncertain effects before replay. Local continuation operation: ${operation.id}.` }],
        source: { kind: 'plugin:dsh-model-fusion', form: 'notice', summary: bi('用户通过 Fusion 控件继续当前任务', 'The user continued the task from the Fusion controls') } })
      view = { ...view, epoch: view.epoch + (change ? 1 : 0), recoveryEpoch: (view.recoveryEpoch ?? 0) + 1,
        routes: change ? { ...view.routes, [change.role]: change.route } : view.routes,
        waits: change ? Object.fromEntries(Object.entries(view.waits).filter(([role]) => role !== change.role)) : {}, operation: { ...operation, message },
        ...(view.schedule ? { schedule: { ...view.schedule, state: scheduledId ? 'fired' : 'cancelled' } } : {}) }
      view.revision = this.write(view)
      for (const id of this.store.listDocumentIds(`progress:${taskId}:`)) {
        const row = this.store.readDocument(id)!
        this.store.writeDocument(id, row.revision, { count: 0 })
      }
      for (const id of this.store.listDocumentIds(`workflow-progress:${taskId}:`)) {
        const row = this.store.readDocument(id)!
        this.store.writeDocument(id, row.revision, { schemaVersion: 1, milestone: '', recent: [] })
      }
      this.clearTimer(sessionId)
      try {
        await this.callbacks.resume(agent)
        if (this.#closed || this.userSeq(agent) !== userSeq) throw new Error(bi('恢复期间出现新消息或插件已退出', 'A new message arrived or the plugin exited during recovery'))
        view = { ...view, operation: { ...view.operation!, state: 'dispatching' } }
        view.revision = this.write(view)
        agent.send(message, 'next-turn', true)
        const delivered = agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(item => item.id === message.id))
        if (!delivered) throw new Error(bi('继续消息未获得原生收件箱确认；不会自动重发', 'The native inbox did not confirm the continuation; it is not resent automatically'))
        this.write({ ...view, operation: { ...view.operation!, state: 'delivered' } })
      } catch (error) {
        if (view.operation?.state === 'prepared') this.write({ ...view, operation: { ...view.operation, state: 'failed', error: String(error) } })
        throw error
      }
    } finally { this.#locks.delete(sessionId) }
  }
  private clearTimer(sessionId: string) { clearTimeout(this.#timers.get(sessionId)); this.#timers.delete(sessionId) }
  private arm(binding: SessionBinding) {
    this.clearTimer(binding.sessionId)
    if (this.#closed || binding.profile.interactionMode !== 'model-like') return
    const view = readModelControl(this.store, binding)!, schedule = view.schedule
    if (schedule?.state !== 'scheduled') return
    const delay = Math.max(0, Date.parse(schedule.dueAt) - Date.now())
    const timer = setTimeout(() => {
      this.#timers.delete(binding.sessionId)
      const current = this.#bindings.read(binding.sessionId)?.binding
      if (!current?.selected || current.taskId !== schedule.taskId || this.store.load(current.taskId)?.control.mode === 'completed') {
        if (current?.selected && current.profile.interactionMode === 'model-like') this.cancel(current, bi('任务已结束或切换', 'The task ended or changed'))
        return
      }
      if (delay > 60_000) { this.arm(current); return }
      const fresh = readModelControl(this.store, current)!
      void this.continue(current.sessionId, current.taskId, fresh.revision, undefined, schedule.id).catch(error => {
        const latest = readModelControl(this.store, current)!
        if (latest.schedule?.id === schedule.id && latest.schedule.state === 'scheduled') this.write({ ...latest,
          schedule: { ...latest.schedule, state: 'failed', reason: String(error) } })
      })
    }, Math.min(delay, 60_000))
    timer.unref(); this.#timers.set(binding.sessionId, timer)
  }
  async close() {
    this.#closed = true
    for (const id of this.#timers.keys()) this.clearTimer(id)
    this.#dispose.forEach(dispose => dispose())
    await Promise.allSettled(this.#pending)
  }
}
