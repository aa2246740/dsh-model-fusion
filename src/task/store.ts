import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ArtifactRef, FusionEvent, OutboxRow, OutboxState, TaskId } from '../contracts.js'
import { ArtifactId } from '../contracts.js'
import { digestOf, sha256Hex } from '../digest.js'
import { CHECKSUM_MISMATCH, EVENT_CONFLICT, FLUSH_FAILED, FusionError, REVISION_CONFLICT, STORE_MIGRATION_REQUIRED } from '../errors.js'
import { reduce, reduceAll } from './reducer.js'
import type { PersistedTask, TaskState } from './state.js'

export interface StoreIo {
  existsSync(path: string): boolean
  mkdirSync(path: string): void
  readFileSync(path: string): string
  writeFileSync(path: string, data: string | Uint8Array): void
  renameSync(from: string, to: string): void
  rmSync(path: string): void
}

export const nodeIo: StoreIo = {
  existsSync,
  mkdirSync: path => mkdirSync(path, { recursive: true }),
  readFileSync: path => readFileSync(path, 'utf8'),
  writeFileSync: (path, data) => writeFileSync(path, data),
  renameSync,
  rmSync: path => rmSync(path, { force: true }),
}

export interface ArtifactRecord extends ArtifactRef {
  readonly storageRef: string
}

export const STORE_PROJECTION_VERSION = 2

export interface DiskSnapshot {
  readonly projectionVersion: typeof STORE_PROJECTION_VERSION
  readonly checksum: string
  readonly persisted: PersistedTask
  readonly artifacts: readonly ArtifactRecord[]
}

/** The reducer and review producer share this port across file and transactional stores. */
export type FusionStore = Pick<FileFusionStore,
  'load' | 'replay' | 'create' | 'transact' | 'append' | 'putArtifact' |
  'prepareOutbox' | 'advanceOutbox' | 'outbox' | 'artifacts'>

export class FileFusionStore {
  readonly #memory = new Map<TaskId, DiskSnapshot>()

  constructor(
    readonly root: string,
    readonly io: StoreIo = nodeIo,
  ) {}

  load(taskId: TaskId): TaskState | undefined {
    return this.#read(taskId)?.persisted.state
  }

  replay(taskId: TaskId): TaskState {
    const snap = this.#require(taskId)
    return reduceAll(snap.persisted.events)
  }

  create(event: Extract<FusionEvent, { type: 'task/created' }>): TaskState {
    if (this.load(event.taskId)) throw new FusionError(EVENT_CONFLICT, 'task exists')
    const state = reduce(undefined, event)
    this.#persist(event.taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: { state, events: [event], outbox: [] },
      artifacts: [],
    })
    return this.#require(event.taskId).persisted.state
  }

  transact(
    taskId: TaskId,
    expectedSeq: number,
    mutate: (current: PersistedTask) => { events?: readonly FusionEvent[]; outbox?: readonly OutboxRow[] },
  ): TaskState {
    const current = this.#require(taskId)
    if (current.persisted.state.seq !== expectedSeq) {
      throw new FusionError(EVENT_CONFLICT, `expected seq ${expectedSeq}, have ${current.persisted.state.seq}`)
    }
    const patch = mutate(current.persisted)
    let state = current.persisted.state
    const nextEvents = [...current.persisted.events]
    for (const event of patch.events ?? []) {
      if (state.appliedEventIds.includes(event.id)) continue
      state = reduce(state, event)
      nextEvents.push(event)
    }
    this.#persist(taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: {
        state,
        events: nextEvents,
        outbox: patch.outbox ?? current.persisted.outbox,
      },
      artifacts: current.artifacts,
    })
    return this.#require(taskId).persisted.state
  }

  append(taskId: TaskId, expectedRevision: number, events: readonly FusionEvent[]): TaskState {
    const current = this.#require(taskId)
    if (current.persisted.state.revision !== expectedRevision) {
      throw new FusionError(REVISION_CONFLICT, `expected revision ${expectedRevision}, have ${current.persisted.state.revision}`)
    }
    let state = current.persisted.state
    const nextEvents = [...current.persisted.events]
    for (const event of events) {
      if (state.appliedEventIds.includes(event.id)) continue
      state = reduce(state, event)
      nextEvents.push(event)
    }
    this.#persist(taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: { state, events: nextEvents, outbox: current.persisted.outbox },
      artifacts: current.artifacts,
    })
    return this.#require(taskId).persisted.state
  }

  putArtifact(taskId: TaskId, bytes: Uint8Array, mediaType: string): ArtifactRef {
    const current = this.#require(taskId)
    const digest = sha256Hex(bytes)
    const dir = this.#taskDir(taskId)
    this.io.mkdirSync(join(dir, 'artifacts'))
    const finalPath = join(dir, 'artifacts', digest)
    const partPath = `${finalPath}.part`
    this.io.writeFileSync(partPath, bytes)
    this.io.renameSync(partPath, finalPath)
    const record: ArtifactRecord = {
      id: ArtifactId(digest),
      digest,
      ownerTaskId: taskId,
      mediaType,
      bytes: bytes.byteLength,
      storageRef: finalPath,
    }
    this.#persist(taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: current.persisted,
      artifacts: [...current.artifacts.filter(item => item.digest !== digest), record],
    })
    return record
  }

  prepareOutbox(row: OutboxRow): OutboxRow {
    const current = this.#require(row.taskId)
    const existing = current.persisted.outbox.find(item => item.operationId === row.operationId)
    if (existing) return existing
    this.#persist(row.taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: { ...current.persisted, outbox: [...current.persisted.outbox, { ...row, state: 'prepared' }] },
      artifacts: current.artifacts,
    })
    return this.outbox(row.taskId).find(item => item.operationId === row.operationId)!
  }

  advanceOutbox(taskId: TaskId, operationId: string, from: OutboxState, to: OutboxState, patch: Partial<OutboxRow> = {}): OutboxRow {
    const current = this.#require(taskId)
    const next = current.persisted.outbox.map(row => {
      if (row.operationId !== operationId) return row
      if (row.state !== from) throw new FusionError(EVENT_CONFLICT, `outbox ${operationId} is ${row.state}, not ${from}`)
      return { ...row, ...patch, state: to }
    })
    if (!next.some(row => row.operationId === operationId)) {
      throw new FusionError(EVENT_CONFLICT, `outbox ${operationId} missing`)
    }
    this.#persist(taskId, {
      projectionVersion: STORE_PROJECTION_VERSION,
      checksum: '',
      persisted: { ...current.persisted, outbox: next },
      artifacts: current.artifacts,
    })
    return this.outbox(taskId).find(row => row.operationId === operationId)!
  }

  outbox(taskId: TaskId): readonly OutboxRow[] {
    return this.#require(taskId).persisted.outbox
  }

  artifacts(taskId: TaskId): readonly ArtifactRecord[] {
    return this.#require(taskId).artifacts
  }

  #taskDir(taskId: TaskId): string {
    return join(this.root, 'tasks', taskId)
  }

  #read(taskId: TaskId): DiskSnapshot | undefined {
    const cached = this.#memory.get(taskId)
    if (cached) return cached
    const path = join(this.#taskDir(taskId), 'snapshot.json')
    if (!this.io.existsSync(path)) return undefined
    const raw = this.io.readFileSync(path)
    const parsed = decodeStoreSnapshot(raw, taskId)
    this.#memory.set(taskId, parsed)
    return parsed
  }

  #require(taskId: TaskId): DiskSnapshot {
    const snap = this.#read(taskId)
    if (!snap) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`)
    return snap
  }

  #persist(taskId: TaskId, next: DiskSnapshot): void {
    const checksum = digestOf({ persisted: next.persisted, artifacts: next.artifacts })
    const snapshot: DiskSnapshot = { ...next, projectionVersion: STORE_PROJECTION_VERSION, checksum }
    const dir = this.#taskDir(taskId)
    this.io.mkdirSync(dir)
    const finalPath = join(dir, 'snapshot.json')
    const tmpPath = `${finalPath}.tmp`
    try {
      this.io.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`)
      this.io.renameSync(tmpPath, finalPath)
    } catch (error) {
      try {
        this.io.rmSync(tmpPath)
      } catch {
        /* ignore */
      }
      throw new FusionError(FLUSH_FAILED, error instanceof Error ? error.message : 'flush failed')
    }
    this.#memory.set(taskId, snapshot)
  }
}

/** Validate before either backend admits a persisted execution projection. */
export function decodeStoreSnapshot(raw: string, taskId: TaskId): DiskSnapshot {
  let parsed: DiskSnapshot
  try { parsed = JSON.parse(raw) as DiskSnapshot } catch {
    throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} is not a JSON store document`)
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.persisted) {
    throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} is not a store document`)
  }
  if (parsed.checksum !== digestOf({ persisted: parsed.persisted, artifacts: parsed.artifacts })) {
    throw new FusionError(CHECKSUM_MISMATCH, `corrupt snapshot for ${taskId}`)
  }
  requireStorageProjectionVersion(parsed)
  const state = parsed.persisted.state
  const control = state?.control
  if (!control || !['running', 'paused', 'stop-requested', 'cancelled', 'completed'].includes(control.mode)
    || !Array.isArray(control.pendingApprovalIds) || !control.pendingApprovalIds.every(id => typeof id === 'string')
    || typeof control.budgetBlocked !== 'boolean' || typeof control.recovering !== 'boolean'
    || typeof control.outcomeUnknown !== 'boolean'
    || !Array.isArray(state.pendingApprovalIds) || !state.pendingApprovals
    || !Array.isArray(state.appliedEventIds) || !Array.isArray(state.ignoredReviewResults)
    || !Array.isArray(state.staleValidations) || !Number.isSafeInteger(state.reviewGeneration)
    || !Array.isArray(parsed.persisted.events) || !Array.isArray(parsed.persisted.outbox)
    || !Array.isArray(parsed.artifacts) || state.taskId !== taskId) {
    throw new FusionError(STORE_MIGRATION_REQUIRED, `snapshot for ${taskId} has an incomplete execution projection`)
  }
  return parsed
}

export function requireStorageProjectionVersion(raw: unknown): asserts raw is DiskSnapshot {
  if (!raw || typeof raw !== 'object') throw new FusionError(STORE_MIGRATION_REQUIRED, 'INVALID_STORE_DOCUMENT')
  if ((raw as { projectionVersion?: number }).projectionVersion !== STORE_PROJECTION_VERSION) {
    throw new FusionError(STORE_MIGRATION_REQUIRED, 'STORE_MIGRATION_REQUIRED')
  }
}

export function failingRenameIo(base: StoreIo, failOnce = true): StoreIo {
  let failed = false
  return {
    ...base,
    renameSync(from, to) {
      if (dirname(to).endsWith('artifacts')) {
        base.renameSync(from, to)
        return
      }
      if (!failed || !failOnce) {
        failed = true
        throw new Error('injected flush failure')
      }
      base.renameSync(from, to)
    },
  }
}
