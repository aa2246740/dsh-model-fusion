import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { digestOf } from '../digest.js'
import type { Role } from '../contracts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'

export const enforcedWorkflow = (binding: SessionBinding) => binding.profile.workflowPolicy === 'enforced-v1' || binding.profile.workflowPolicy === 'enforced-v2' || binding.profile.workflowPolicy === 'enforced-v3'
/** v3 keeps every v2 mechanism and adds role separation (see native-role-sandbox). */
export const adaptiveWorkflow = (binding: SessionBinding) => binding.profile.workflowPolicy === 'enforced-v2' || binding.profile.workflowPolicy === 'enforced-v3'

export interface ProgressWindow {
  schemaVersion: 1
  milestone: string
  recent: string[]
  tinyRead?: { path: string; count: number }
}
export interface ProgressObservation {
  milestone: string
  fingerprint?: string
  tinyPath?: string
  role: Role
}

/** Results, not model explanations, drive this bounded and persistable detector. */
export function advanceProgress(previous: ProgressWindow | undefined, observation: ProgressObservation): { window: ProgressWindow; stalled: boolean } {
  const prior = previous?.milestone === observation.milestone ? previous : undefined
  const recent = [...(prior?.recent ?? []), observation.fingerprint ?? ''].slice(-8)
  const tinyRead = observation.tinyPath ? { path: observation.tinyPath,
    count: prior?.tinyRead?.path === observation.tinyPath ? prior.tinyRead.count + 1 : 1 } : undefined
  return { window: { schemaVersion: 1, milestone: observation.milestone, recent, ...(tinyRead ? { tinyRead } : {}) },
    stalled: Boolean(observation.fingerprint && recent.filter(item => item === observation.fingerprint).length >= 3
      || tinyRead && tinyRead.count >= (observation.role === 'lead' ? 12 : 32)) }
}

/** Only public execution results and durable task facts enter the workflow controller. */
export class NativeWorkflow {
  constructor(readonly store: SqliteFusionStore) {}

  milestone(binding: SessionBinding): string {
    const state = this.store.load(binding.taskId)!
    const runtime = this.store.readDocument(`runtime:${binding.taskId}`)?.value as { briefRevision?: number; submitted?: unknown; takeover?: boolean } | undefined
    const control = adaptiveWorkflow(binding) ? this.store.readDocument(`model-control:${binding.sessionId}`)?.value as { recoveryEpoch?: number } | undefined : undefined
    return digestOf({ order: state.currentWorkOrder?.id, revision: state.currentWorkOrder?.revision,
      brief: runtime?.briefRevision, submitted: runtime?.submitted, takeover: runtime?.takeover,
      phase: state.phase, report: state.validatedReport, review: state.reviewResult,
      ...(adaptiveWorkflow(binding) ? { recoveryEpoch: control?.recoveryEpoch ?? 0 } : {}) })
  }

  observe(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>, binding: SessionBinding, role: Role, read: boolean): boolean {
    // Required recovery pagination and a live job wait must neither spend nor erase the window.
    if (exec.name === 'fusion_read_state' || exec.name === 'job_output') return false
    const id = `workflow-progress:${binding.taskId}:${exec.agent!.id}`, row = this.store.readDocument(id)
    const shell = exec.name === 'bash' && !result.isError ? result.value as { exitCode?: unknown } : undefined
    const failed = result.isError || typeof shell?.exitCode === 'number' && shell.exitCode !== 0
    const args = exec.arguments as { file_path?: string; path?: string; limit?: number }
    const fingerprint = failed || read || exec.name.startsWith('fusion_')
      ? digestOf({ name: exec.name, args: exec.arguments, error: result.isError, content: result.content }) : undefined
    // Advancing through a file is real progress, however inefficient. Frozen v1
    // retains its old slicing detector; v2 only interrupts repeated outcomes.
    const tinyPath = !adaptiveWorkflow(binding) && !failed && exec.name === 'read' && typeof args.limit === 'number' && args.limit <= 2
      ? args.file_path ?? args.path : undefined
    const next = advanceProgress(row?.value as ProgressWindow | undefined, {
      milestone: this.milestone(binding), fingerprint, tinyPath, role,
    })
    this.store.writeDocument(id, row?.revision ?? 0, next.window)
    return next.stalled
  }

  /** One local replanning opportunity, not an immediate request for user intervention. */
  repairProgress(agent: Agent, binding: SessionBinding, role: Role): boolean {
    if (!adaptiveWorkflow(binding)) return false
    const id = `workflow-replan:${binding.taskId}:${agent.id}:${this.milestone(binding)}`
    if (this.store.readDocument(id)) return false
    this.store.writeDocument(id, 0, { schemaVersion: 1, role, at: new Date().toISOString() })
    const progressId = `workflow-progress:${binding.taskId}:${agent.id}`, row = this.store.readDocument(progressId)
    this.store.writeDocument(progressId, row?.revision ?? 0, { schemaVersion: 1, milestone: this.milestone(binding), recent: [] })
    agent.send(createUserMessage({ source: { kind: 'plugin:dsh-model-fusion', form: 'notice', summary: 'Fusion 检测到重复结果，正在调整执行方式' },
      content: [{ type: 'text', text: 'The runtime detected repeated unchanged tool results. Use the evidence already collected and change the approach instead of repeating those calls. Continue the current task; delegate broad work if useful. Another unchanged cycle will pause this role without discarding progress.' }] }), 'next-step', false)
    return true
  }

  denyEffect(binding: SessionBinding): string {
    const id = `workflow-effect-denied:${binding.taskId}`
    if (!this.store.readDocument(id)) this.store.writeDocument(id, 0, { schemaVersion: 1, taskId: binding.taskId })
    return 'FUSION_LEAD_READ_ONLY: execution belongs to the Sidekick. Use fusion_delegate for workspace changes or commands; fusion_explore for investigation. Lead takeover requires a current implementation report and a recorded rework review.'
  }

  deniedEffect(binding: SessionBinding): boolean { return Boolean(this.store.readDocument(`workflow-effect-denied:${binding.taskId}`)) }

  /** At most one repair generation per role and durable milestone, surviving reloads. */
  repairStop(agent: Agent, binding: SessionBinding, role: Role, instruction: string): boolean {
    const id = `workflow-stop:${binding.taskId}:${agent.id}:${this.milestone(binding)}`
    if (this.store.readDocument(id)) return false
    this.store.writeDocument(id, 0, { schemaVersion: 1, role, at: new Date().toISOString() })
    agent.send(createUserMessage({ source: { kind: 'plugin:dsh-model-fusion', form: 'notice', summary: 'Fusion 工作流尚未完成' },
      content: [{ type: 'text', text: instruction }] }), 'next-step', false)
    return true
  }
}
