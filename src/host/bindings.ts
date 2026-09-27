import type { PairProfile, TaskId } from '../contracts.js'
import { TaskId as taskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import { completeProfile } from '../profile/resolve.js'
import type { PromptBundle, ResolvedProfile } from '../profile/resolve.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'

export interface SessionBinding {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly taskId: TaskId
  readonly selected: boolean
  /** One native continuable Worker for this selection, across completed tasks. */
  readonly workerId?: string
  readonly profile: PairProfile
  readonly prompts: PromptBundle
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Fusion session binding')
  return value as Record<string, unknown>
}

export function readBinding(value: unknown, sessionId: string): SessionBinding {
  const row = object(value)
  if (row.schemaVersion !== 1 || row.sessionId !== sessionId || typeof row.taskId !== 'string'
    || typeof row.selected !== 'boolean') throw new Error('Fusion binding migration or reconciliation required')
  const prompt = object(row.prompts)
  if (row.workerId !== undefined && (typeof row.workerId !== 'string' || !row.workerId || row.workerId.includes('\0'))) {
    throw new Error('Invalid persistent Fusion Worker identity')
  }
  if (typeof prompt.lead !== 'string' || typeof prompt.worker !== 'string' || typeof prompt.compact !== 'string') {
    throw new Error('Frozen Fusion prompts are missing')
  }
  const prompts: PromptBundle = { lead: prompt.lead, worker: prompt.worker, compact: prompt.compact }
  const profile = completeProfile(object(row.profile), prompts)
  if (digestOf(profile) !== digestOf(row.profile)) throw new Error('Frozen Fusion profile or prompt digest changed')
  return { schemaVersion: 1, sessionId, taskId: taskId(row.taskId), selected: row.selected, profile, prompts,
    ...(row.workerId === undefined ? {} : { workerId: row.workerId as string }) }
}

/** Selection is durable and scoped by the native Lead identity, never a global default. */
export class BindingRepository {
  constructor(private readonly store: SqliteFusionStore) {}

  read(sessionId: string): { revision: number; binding: SessionBinding } | undefined {
    const document = this.store.readDocument(`binding:${sessionId}`)
    return document ? { revision: document.revision, binding: readBinding(document.value, sessionId) } : undefined
  }

  select(sessionId: string, id: TaskId, resolved: ResolvedProfile): SessionBinding {
    const prior = this.read(sessionId)
    if (prior?.binding.selected) throw new Error('Fusion is already selected for this session')
    const binding: SessionBinding = {
      schemaVersion: 1, sessionId, taskId: id, selected: true,
      profile: structuredClone(resolved.profile), prompts: structuredClone(resolved.prompts),
    }
    readBinding(binding, sessionId)
    this.store.writeDocument(`binding:${sessionId}`, prior?.revision ?? 0, binding)
    return binding
  }

  clear(sessionId: string): void {
    const prior = this.read(sessionId)
    if (!prior || !prior.binding.selected) return
    this.store.writeDocument(`binding:${sessionId}`, prior.revision, { ...prior.binding, selected: false })
  }

  /** Reserve identity before native dispatch; an existing selection cannot swap workers. */
  assignWorker(sessionId: string, expectedTask: TaskId, workerId: string): void {
    const prior = this.read(sessionId)
    if (!prior?.binding.selected || prior.binding.taskId !== expectedTask) throw new Error('Fusion binding changed before Worker dispatch')
    if (prior.binding.workerId && prior.binding.workerId !== workerId) throw new Error('Persistent Worker identity cannot change within a Fusion selection')
    const binding = { ...prior.binding, workerId }
    readBinding(binding, sessionId)
    this.store.writeDocument(`binding:${sessionId}`, prior.revision, binding)
  }

  /** A new native user turn starts a new task while preserving the frozen pair. */
  rollover(sessionId: string, expectedTask: TaskId, nextTask: TaskId): SessionBinding {
    const prior = this.read(sessionId)
    if (!prior?.binding.selected || prior.binding.taskId !== expectedTask) throw new Error('Fusion binding changed during task rollover')
    const binding = { ...prior.binding, taskId: nextTask }
    this.store.writeDocument(`binding:${sessionId}`, prior.revision, binding)
    return binding
  }

  selected(): readonly SessionBinding[] {
    return this.store.listDocumentIds('binding:').map(id => this.read(id.slice('binding:'.length))!.binding).filter(row => row.selected)
  }
}
