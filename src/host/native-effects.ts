import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import type { ArtifactRef, Role, TaskId } from '../contracts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'

interface EffectRecord {
  schemaVersion: 1
  taskId: TaskId
  agentId: string
  role: Role
  callId: string
  rootCallId: string
  toolName: string
  processId: number
  startedAt: string
  state: 'dispatch-started' | 'returned' | 'outcome-unknown' | 'inspected'
  arguments: ArtifactRef
  endedAt?: string
  nativeIsError?: boolean
  inspectionEvidence?: string
  quiescenceBasis?: 'explicit-user-inspection'
  nativeJob?: { id: string; startedAt: number; deadlineAt: number | null; status: JobView['status']; detail?: string }
}

/** Public native dispatch journal; it never wraps a provider or invents a PID. */
export class NativeEffects {
  readonly #live = new Map<symbol, TaskId>()
  readonly #waiters = new Map<symbol, Agent>()
  readonly #jobs = new Map<string, { id: string; row: EffectRecord; agent: Agent; timer: ReturnType<typeof setTimeout> | undefined }>()
  readonly #registry: Context['jobs'] | undefined
  constructor(readonly ctx: Context, readonly store: SqliteFusionStore, readonly callbacks: {
    owner(agent: Agent): { binding: SessionBinding; role: Role } | undefined
    track(exec: Readonly<ToolExecution>): boolean
    failed(agent: Agent, error: unknown): void
    backgroundMaxMs?(exec: Readonly<ToolExecution>, binding: SessionBinding): number | null
  }) { this.#registry = ctx.get('jobs') }

  install(): () => void {
    const offJobs = this.#registry?.events.subscribe({ owners: 'all' }, event => {
      if (event.type !== 'settled') return
      const snapshot = event.job
      const live = this.#jobs.get(snapshot.id)
      if (live && snapshot.owner === live.agent.id) this.#settled(live, snapshot)
    })
    const offTools = this.ctx.on('tools/execute', async (exec, next) => {
      const owner = exec.agent && this.callbacks.owner(exec.agent)
      if (owner && exec.name === 'job_output') {
        this.#waiters.set(exec.token, exec.agent!)
        try { return await next() } finally { this.#waiters.delete(exec.token) }
      }
      if (!owner || !this.callbacks.track(exec)) return next()
      const taskId = owner.binding.taskId, id = `native-effect:${taskId}:${randomUUID()}`
      let row: EffectRecord
      try {
        row = { schemaVersion: 1, taskId, agentId: exec.agent!.id, role: owner.role,
          callId: exec.callId, rootCallId: exec.rootCallId, toolName: exec.name, processId: process.pid,
          startedAt: new Date().toISOString(), state: 'dispatch-started',
          arguments: this.store.putArtifact(taskId, Buffer.from(JSON.stringify({ tool: exec.name, arguments: exec.arguments })), 'application/vnd.dsh-fusion.native-effect+json') }
        this.store.writeDocument(id, 0, row)
      } catch (error) { this.callbacks.failed(exec.agent!, error); throw error }
      this.#live.set(exec.token, taskId)
      try {
        const result = await next()
        const value = !result.isError && result.value
        if (exec.name === 'bash' && (exec.arguments as { run_in_background?: unknown }).run_in_background === true && !result.isError) {
          const background = value as { kind?: unknown; jobId?: unknown } | null
          if (!background || background.kind !== 'background' || typeof background.jobId !== 'string') {
            throw new Error('Native background bash returned no authoritative job identity')
          }
          const snapshot = this.#registry!.get(JobId(background.jobId), exec.agent?.id)
          if (snapshot.kind !== 'bash' || snapshot.owner !== exec.agent!.id) throw new Error('Native job ownership mismatch')
          const maximum = this.callbacks.backgroundMaxMs ? this.callbacks.backgroundMaxMs(exec, owner.binding) : 60_000
          const requested = (exec.arguments as { timeoutMs?: unknown }).timeoutMs
          const timeout = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
            ? Math.min(requested, maximum ?? Infinity) : maximum
          if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('Background command deadline is unavailable')
          row = { ...row, nativeJob: { id: snapshot.id, startedAt: snapshot.startedAt,
            deadlineAt: timeout === null ? null : Date.now() + Math.ceil(timeout), status: snapshot.status } }
          const timer = timeout === null ? undefined : setTimeout(() => {
            try {
              this.#assertJob(row, this.#registry!.get(snapshot.id, exec.agent?.id))
              this.#registry!.kill(snapshot.id, exec.agent?.id, 'Fusion command deadline elapsed')
            } catch (error) {
              const live = this.#jobs.get(snapshot.id)
              if (live) this.#uncertain(live, error)
              else this.callbacks.failed(exec.agent!, error)
            }
          }, timeout)
          timer?.unref()
          const live = { id, row, agent: exec.agent!, timer }
          this.#jobs.set(snapshot.id, live)
          this.store.writeDocument(id, 1, row)
          if (snapshot.status !== 'running' && snapshot.status !== 'stopping') this.#settled(live, snapshot)
          return result
        }
        // This means the native tool promise returned, not that its mutation
        // was correct, or that a post-crash provider range was inspected.
        this.store.writeDocument(id, 1, { ...row, state: 'returned', endedAt: new Date().toISOString(), nativeIsError: Boolean(result.isError) })
        return result
      } catch (error) {
        // A start may have succeeded before durable job identity could be saved.
        // Cancel only this exact native job, never replay the command.
        if (row.nativeJob && this.#jobs.has(row.nativeJob.id)) {
          try { this.#registry!.kill(JobId(row.nativeJob.id), exec.agent?.id, 'Fusion job tracking failed') }
          catch (stopError) { this.callbacks.failed(exec.agent!, stopError) }
        }
        try {
          this.store.writeDocument(id, this.store.readDocument(id)!.revision,
            { ...row, state: 'outcome-unknown', endedAt: new Date().toISOString() })
        } catch (recordingError) { this.callbacks.failed(exec.agent!, recordingError) }
        this.callbacks.failed(exec.agent!, error)
        throw error
      } finally { this.#live.delete(exec.token) }
    }, { prepend: true })
    return () => {
      offTools(); offJobs?.()
      for (const live of this.#jobs.values()) clearTimeout(live.timer)
    }
  }

  #settled(live: { id: string; row: EffectRecord; agent: Agent; timer: ReturnType<typeof setTimeout> | undefined }, snapshot: JobView): void {
    try {
      this.#assertJob(live.row, snapshot)
      if (snapshot.status === 'running' || snapshot.status === 'stopping') return
      const row = this.store.readDocument(live.id)!
      this.store.writeDocument(live.id, row.revision, { ...live.row,
        nativeJob: { ...live.row.nativeJob!, status: snapshot.status, ...(snapshot.detail ? { detail: snapshot.detail } : {}) },
        state: snapshot.status === 'failed' ? 'outcome-unknown' : 'returned', endedAt: new Date().toISOString() })
      // Failed registry records can result from a throwing producer cancel;
      // unlike completed/killed bash, that does not prove process quiescence.
      if (snapshot.status === 'failed') this.callbacks.failed(live.agent, new Error('Native job failed without proven process quiescence'))
    } catch (error) { this.callbacks.failed(live.agent, error) }
    finally { clearTimeout(live.timer); this.#jobs.delete(snapshot.id) }
  }

  #assertJob(row: EffectRecord, snapshot: JobView): void {
    if (!row.nativeJob || row.processId !== process.pid || snapshot.id !== row.nativeJob.id
      || snapshot.kind !== 'bash' || snapshot.owner !== row.agentId || snapshot.startedAt !== row.nativeJob.startedAt) {
      throw new Error('Native job identity changed; inspect rather than adopting or replaying it')
    }
  }

  #uncertain(live: { id: string; row: EffectRecord; agent: Agent; timer: ReturnType<typeof setTimeout> | undefined }, error: unknown): void {
    clearTimeout(live.timer)
    this.#jobs.delete(live.row.nativeJob!.id)
    try {
      const row = this.store.readDocument(live.id)!
      this.store.writeDocument(live.id, row.revision, { ...live.row, state: 'outcome-unknown' })
    } catch (recordingError) { this.callbacks.failed(live.agent, recordingError) }
    this.callbacks.failed(live.agent, error)
  }

  backgroundProblem(exec: Readonly<ToolExecution>): string | undefined {
    if (!this.#registry || !exec.agent || !this.ctx.tools.get('job_output', exec.agent?.id) || !this.ctx.tools.get('job_kill', exec.agent?.id)) {
      return 'Background commands require the native jobs runtime and visible job_output/job_kill tools'
    }
    return undefined
  }

  jobProblem(exec: Readonly<ToolExecution>, taskId: TaskId): string | undefined {
    const id = (exec.arguments as { job_id?: unknown }).job_id
    if (typeof id !== 'string' || !exec.agent || !this.#registry) return 'Native job identity is required'
    const record = this.store.listDocumentIds(`native-effect:${taskId}:`).map(key => this.store.readDocument(key)!.value as EffectRecord)
      .find(row => row.nativeJob?.id === id && row.agentId === exec.agent!.id && row.taskId === taskId)
    if (!record) return 'Only native jobs recorded for this Agent and current Fusion task may be accessed'
    try { this.#assertJob(record, this.#registry.get(JobId(id), exec.agent?.id)) }
    catch (error) { return String(error) }
    return undefined
  }

  waitingForJob(agent: Agent): boolean { return [...this.#waiters.values()].includes(agent) }

  onlyBackgroundPending(taskId: TaskId): boolean {
    const pending = this.pending(taskId)
    return pending.length > 0 && pending.every(({ id, record }) => record.state === 'dispatch-started'
      && record.nativeJob && this.#jobs.get(record.nativeJob.id)?.id === id)
  }

  async stopJobs(taskId: TaskId): Promise<void> {
    for (const live of [...this.#jobs.values()].filter(job => job.row.taskId === taskId)) {
      try {
        const id = JobId(live.row.nativeJob!.id)
        this.#assertJob(live.row, this.#registry!.get(id, live.agent.id))
        this.#registry!.kill(id, live.agent.id, 'Fusion task is stopping')
        const done = await this.#registry!.wait(id, 10_000, live.agent.id)
        if (done.status === 'running' || done.status === 'stopping' || done.status === 'failed') {
          throw new Error('Native job did not prove process quiescence; keep the writer and inspect')
        }
        if (this.#jobs.has(id)) this.#settled(live, done)
      } catch (error) { this.#uncertain(live, error); throw error }
    }
  }

  pending(taskId: TaskId): readonly { id: string; record: EffectRecord }[] {
    return this.store.listDocumentIds(`native-effect:${taskId}:`).flatMap(id => {
      const record = this.store.readDocument(id)!.value as EffectRecord
      if (record.schemaVersion !== 1 || record.taskId !== taskId || !record.agentId || !record.toolName
        || !Number.isSafeInteger(record.processId) || record.processId <= 0
        || !['dispatch-started', 'returned', 'outcome-unknown', 'inspected'].includes(record.state)) {
        throw new Error('Native effect journal requires migration or inspection')
      }
      if (record.nativeJob && (typeof record.nativeJob.id !== 'string'
        || !Number.isSafeInteger(record.nativeJob.startedAt) || record.nativeJob.deadlineAt !== null && !Number.isSafeInteger(record.nativeJob.deadlineAt))) {
        throw new Error('Native job journal requires migration or inspection')
      }
      return record.state === 'dispatch-started' || record.state === 'outcome-unknown' ? [{ id, record }] : []
    })
  }

  assertInspection(taskId: TaskId, effectsStopped: boolean): void {
    const pending = this.pending(taskId)
    if (!pending.length) return
    if ([...this.#live.values()].includes(taskId) || [...this.#jobs.values()].some(job => job.row.taskId === taskId)) {
      throw new Error('Native tool execution is still live; stop and settle it before recovery')
    }
    if (!effectsStopped) {
      throw new Error(`有 ${pending.length} 项原生操作在中断时未收尾。Host 退出不代表命令及子进程已停止。请先检查并停止这些操作，再使用 /fusion recover --effects-stopped <检查记录>。`)
    }
    for (const { record } of pending) {
      if (record.processId === process.pid) continue
      try { process.kill(record.processId, 0); throw new Error('The recorded effect owner is still live; settle it before recovery') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }

  inspected(taskId: TaskId, evidence: string, effectsStopped: boolean): void {
    this.assertInspection(taskId, effectsStopped)
    if (!evidence) throw new Error('Effect inspection evidence is required')
    for (const { id, record } of this.pending(taskId)) {
      this.store.writeDocument(id, this.store.readDocument(id)!.revision, { ...record,
        state: 'inspected', inspectionEvidence: evidence, quiescenceBasis: 'explicit-user-inspection' })
    }
  }
}
