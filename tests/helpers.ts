import { expect } from 'vitest'
import type { FusionEvent, TaskId, WorkOrder } from '../src/contracts.js'
import { FusionError } from '../src/errors.js'
import { OperationId, SessionId, SnapshotId, TaskId as asTask, WorkOrderId } from '../src/contracts.js'
import { sha256Hex } from '../src/digest.js'

export const TASK = asTask('task-1')
export const PARENT = SessionId('parent-1')
export const CHILD = SessionId('child-1')
export const SNAP = SnapshotId('snap-1')

export function ev<T extends FusionEvent>(partial: T): T {
  return partial
}

export function created(taskId: TaskId = TASK, id = 'e1'): Extract<FusionEvent, { type: 'task/created' }> {
  return {
    schemaVersion: 1,
    id,
    taskId,
    seq: 1,
    revision: 1,
    type: 'task/created',
    createdAt: '2026-09-20T00:00:00Z',
    causeId: 'user',
    payload: { parent: PARENT, selection: { kind: 'profile', profileId: 'fusion-auto' } },
  }
}

export function order(revision = 1): WorkOrder {
  return {
    schemaVersion: 1,
    taskId: TASK,
    id: WorkOrderId('wo-1'),
    operationId: OperationId('op-1'),
    revision,
    goal: 'fix the bug',
    constraints: [],
    acceptance: [{ id: 't1', description: 'tests pass', verificationKind: 'test', mandatory: true }],
    allowedPaths: ['src'],
    forbiddenActions: ['deploy'],
    baseSnapshot: SNAP,
    evidence: [],
    decisions: [],
    uncertainties: [],
    policy: {
      maxWorkerSteps: 40,
      maxReworkRounds: 2,
      maxCapabilityUpgrades: 1,
      maxTotalOutputTokens: 50_000,
      commandMaxSeconds: 30,
    },
  }
}

export function envelope<T extends FusionEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<FusionEvent, { type: T }>['payload'],
  extras: Partial<Pick<FusionEvent, 'id' | 'revision' | 'taskId'>> = {},
): Extract<FusionEvent, { type: T }> {
  return {
    schemaVersion: 1,
    id: extras.id ?? `e${seq}`,
    taskId: extras.taskId ?? TASK,
    seq,
    revision: extras.revision ?? 1,
    type,
    createdAt: '2026-09-20T00:00:00Z',
    causeId: 'test',
    payload,
  } as Extract<FusionEvent, { type: T }>
}

export function digestText(text: string) {
  return sha256Hex(text)
}

export function expectCode(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(FusionError)
    expect((error as FusionError).code).toBe(code)
    return
  }
  throw new Error(`expected FusionError ${code}`)
}
