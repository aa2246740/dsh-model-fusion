import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId as NativeSessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ArtifactRef, LogicalApproval, Role, TaskId } from '../contracts.js'
import { OperationId, SessionId } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { TaskState } from '../task/state.js'
import type { SessionBinding } from './bindings.js'
import { snapshotWorkspace } from './workspace.js'

type Owner = { binding: SessionBinding; role: Role }
interface Callbacks {
  owner(agent: Agent): Owner | undefined
  state(id: TaskId): TaskState
  pending(id: TaskId, approval: LogicalApproval): void
  answered(id: TaskId, approvalId: string, state: 'approved' | 'rejected' | 'withdrawn'): void
  failed(agent: Agent, error: unknown): void
}
interface ApprovalRecord {
  schemaVersion: 1
  logical: LogicalApproval
  agentId: string
  role: Role
  toolName: string
  callId: string
  rootCallId: string
  askedSeq: number
  askedAt: string
  processId: number
  scopeDigest: string
  evidence: ArtifactRef
  state: 'pending' | 'decided' | 'withdrawn-after-inspection'
  nativeOutcome?: ApprovalOutcome
  decidedSeq?: number
  scopeRejection?: string
  effect?: 'settled' | 'failed'
  inspectionEvidence?: string
  reissuedAs?: string
  previousRequest?: string
}

/** Observe native decisions; never answer on the user's behalf or replay a grant. */
export class NativeApprovals {
  readonly #calls = new Map<Agent, Map<string, Readonly<ToolExecution>>>()
  readonly #requests = new Map<string, string>()
  constructor(readonly ctx: Context, readonly store: SqliteFusionStore, readonly callbacks: Callbacks) {}

  install(): () => void {
    const disposers = [
      this.ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.agent && this.callbacks.owner(exec.agent)) {
          let calls = this.#calls.get(exec.agent)
          if (!calls) this.#calls.set(exec.agent, calls = new Map())
          calls.set(exec.callId, exec)
        }
        return next()
      }, { prepend: true }),
      this.ctx.on('session/event', (session, event) => {
        if (event.type !== 'approval/asked' && event.type !== 'approval/decided') return
        const agent = this.ctx.agents.get(NativeSessionId(session.id)), owner = agent && this.callbacks.owner(agent)
        if (!agent || !owner) return
        try {
          if (event.type === 'approval/asked') this.#asked(agent, owner, event.data, event.seq)
          else this.#decided(owner, event.data.id, event.data.outcome, event.seq)
        } catch (error) { this.callbacks.failed(agent, error) }
      }),
      this.ctx.on('approval/request', async (request, next) => {
        const owner = this.callbacks.owner(request.agent)
        if (!owner) return next()
        // This is deny-only middleware around the native answerer. The audit
        // event already exists; a missing projection must not permit execution.
        const key = this.#requests.get(this.#callKey(request.agent.id, request.callId ?? ''))
        if (!key) return 'unavailable'
        const outcome = await next() // deliberately no timer around human input
        if (outcome !== 'allowed-once') return outcome
        try {
          const row = this.#read(key), exec = this.#calls.get(request.agent)?.get(row.callId)
          const current = this.callbacks.state(owner.binding.taskId)
          const control = current.control
          if (!exec || request.signal?.aborted || control.mode !== 'running' || control.recovering
            || control.outcomeUnknown || control.budgetBlocked
            || row.scopeDigest !== this.#scope(request.agent, owner, exec).digest) {
            this.#write(key, { ...row, scopeRejection: 'The action, workspace, policy or task control changed while approval was pending' })
            return 'rejected'
          }
          return outcome
        } catch (error) { this.callbacks.failed(request.agent, error); return 'unavailable' }
      }, { prepend: true }),
      this.ctx.on('tools/result', (exec, result) => {
        if (!exec.agent) return
        const key = this.#requests.get(this.#callKey(exec.agent.id, exec.callId))
        if (key) {
          try {
            const row = this.#read(key)
            this.#write(key, { ...row,
              logical: row.nativeOutcome === 'allowed-once' ? { ...row.logical, state: 'consumed' } : row.logical,
              effect: result.isError ? 'failed' : 'settled' })
          }
          catch (error) { this.callbacks.failed(exec.agent, error) }
          this.#requests.delete(this.#callKey(exec.agent.id, exec.callId))
        }
        this.#calls.get(exec.agent)?.delete(exec.callId)
      }),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose(); this.#calls.clear(); this.#requests.clear() }
  }

  /** Caller must first stop/release both native Agents and inspect uncertain effects. */
  reconcile(taskId: TaskId, evidence: string): void {
    if (!evidence) throw new Error('Approval recovery requires inspection evidence')
    for (const key of this.store.listDocumentIds(`native-approval:${taskId}:`)) {
      const row = this.#read(key)
      if (row.state !== 'pending') continue
      const agent = this.ctx.agents.get(NativeSessionId(row.agentId))
      if (agent && agent.status !== 'idle' || [...this.#requests.values()].includes(key)) {
        throw new Error('The native approval is still live; settle it before recovery')
      }
      if (row.processId !== process.pid) {
        try { process.kill(row.processId, 0); throw new Error('The recorded approval process is still live') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      // This withdraws the plugin's logical wait after explicit inspection.
      // It does not fabricate a native decision or execute the interrupted call.
      if (this.callbacks.state(taskId).pendingApprovalIds.includes(row.logical.id)) {
        this.callbacks.answered(taskId, row.logical.id, 'withdrawn')
      }
      this.#write(key, { ...row, logical: { ...row.logical, state: 'withdrawn' }, state: 'withdrawn-after-inspection', inspectionEvidence: evidence })
    }
  }

  #asked(agent: Agent, owner: Owner, asked: { id: string; toolName: string; callId?: string; reason?: string }, seq: number): void {
    const exec = asked.callId && this.#calls.get(agent)?.get(asked.callId)
    if (!exec || exec.name !== asked.toolName) throw new Error('Native approval has no matching immutable tool execution')
    const key = `native-approval:${owner.binding.taskId}:${asked.id}`
    if (this.store.readDocument(key)) throw new Error('Native approval identity was reused')
    const scope = this.#scope(agent, owner, exec), state = this.callbacks.state(owner.binding.taskId)
    const previousRequest = this.store.listDocumentIds(`native-approval:${owner.binding.taskId}:`).find(id => {
      const prior = this.#read(id)
      return prior.state === 'withdrawn-after-inspection' && !prior.reissuedAs && prior.scopeDigest === scope.digest
    })
    const prior = previousRequest && this.#read(previousRequest)
    const logical: LogicalApproval = {
      id: prior ? prior.logical.id : `native:${asked.id}`, taskId: owner.binding.taskId, revision: state.revision,
      operationId: prior ? prior.logical.operationId : state.currentWorkOrder?.operationId ?? OperationId(`native-tool:${agent.id}:${exec.callId}`),
      nativeRequestId: asked.id, argsDigest: scope.argsDigest, snapshot: scope.snapshot.id,
      permissionPolicyDigest: scope.policyDigest, state: 'pending',
      requestingAgent: SessionId(agent.id), toolName: exec.name, callId: exec.callId, role: owner.role,
      ...(asked.reason ? { reason: asked.reason } : {}),
    }
    const evidence = this.store.putArtifact(owner.binding.taskId, Buffer.from(JSON.stringify({
      nativeRequestId: asked.id, toolName: exec.name, arguments: exec.arguments,
      snapshot: scope.snapshot, policy: scope.policy,
    })), 'application/vnd.dsh-fusion.approval-scope+json')
    this.store.writeDocument(key, 0, { schemaVersion: 1, logical, agentId: agent.id, role: owner.role,
      toolName: exec.name, callId: exec.callId, rootCallId: exec.rootCallId, askedSeq: seq,
      askedAt: new Date().toISOString(), processId: process.pid, scopeDigest: scope.digest,
      evidence, state: 'pending', ...(previousRequest ? { previousRequest } : {}) } satisfies ApprovalRecord)
    this.callbacks.pending(owner.binding.taskId, logical)
    if (prior && previousRequest) this.#write(previousRequest, { ...prior, reissuedAs: key })
    this.#requests.set(this.#callKey(agent.id, exec.callId), key)
  }

  #decided(owner: Owner, nativeId: string, outcome: ApprovalOutcome, seq: number): void {
    const key = `native-approval:${owner.binding.taskId}:${nativeId}`, row = this.#read(key)
    if (row.state !== 'pending') throw new Error('Native approval already settled')
    // Audit outcomes do not identify a human vs. automated answerer. Leave
    // decisionBy unknown rather than attributing an auto-review to the user.
    const state = outcome === 'allowed-once' ? 'approved' : outcome === 'cancelled' ? 'withdrawn' : 'rejected'
    this.callbacks.answered(owner.binding.taskId, row.logical.id, state)
    this.#write(key, { ...row, logical: { ...row.logical, state }, state: 'decided', nativeOutcome: outcome, decidedSeq: seq })
  }

  #scope(agent: Agent, owner: Owner, exec: Readonly<ToolExecution>) {
    const state = this.callbacks.state(owner.binding.taskId), service = agent.ctx.get('approval') ?? this.ctx.get('approval')
    if (!service || !agent.session.header.cwd) throw new Error('Native approval policy or workspace is unavailable')
    const snapshot = snapshotWorkspace(agent.session.header.cwd)
    const policy = { scope: 'native-approval-and-frozen-fusion-policy',
      nativeApproval: service.overrideOf(agent.session) ?? service.config.policy ?? 'ask',
      profileDigest: owner.binding.profile.digest, allowedPaths: state.currentWorkOrder?.allowedPaths ?? null }
    const argsDigest = digestOf({ tool: exec.name, arguments: exec.arguments }), policyDigest = digestOf(policy)
    return { snapshot, policy, argsDigest, policyDigest,
      digest: digestOf({ taskId: state.taskId, revision: state.revision, agentId: agent.id,
        role: owner.role, argsDigest, snapshot: snapshot.id, policyDigest }) }
  }

  #callKey(agent: string, call: string): string { return JSON.stringify([agent, call]) }
  #read(key: string): ApprovalRecord {
    const row = this.store.readDocument(key)?.value as ApprovalRecord | undefined
    if (!row || row.schemaVersion !== 1 || !row.logical || !row.scopeDigest) throw new Error('Native approval journal requires reconciliation')
    return row
  }
  #write(key: string, row: ApprovalRecord): void { this.store.writeDocument(key, this.store.readDocument(key)!.revision, row) }
}
