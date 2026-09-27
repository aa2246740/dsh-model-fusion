import { taskSummary } from '../host/history.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ArtifactRef, FusionEvent, OutboxRow, OutboxState, TaskId } from '../contracts.js'
import { ArtifactId } from '../contracts.js'
import { digestOf, sha256Hex } from '../digest.js'
import { CHECKSUM_MISMATCH, EVENT_CONFLICT, FusionError, REVISION_CONFLICT, STORE_MIGRATION_REQUIRED } from '../errors.js'
import { reduce, reduceAll } from './reducer.js'
import type { PersistedTask, TaskState } from './state.js'
import { decodeStoreSnapshot, STORE_PROJECTION_VERSION } from './store.js'
import type { ArtifactRecord, DiskSnapshot, FusionStore } from './store.js'

/** Durable Host backend. Every read is fresh; CAS and outbox writes share one transaction. */
export class SqliteFusionStore implements FusionStore {
  readonly #db: DatabaseSync

  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.#db = new DatabaseSync(filename)
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
      const version = this.#db.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== 1) throw new FusionError(STORE_MIGRATION_REQUIRED, 'unknown Fusion database version')
      if (version === 0) {
        const count = this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.n
        if (count !== 0) throw new FusionError(STORE_MIGRATION_REQUIRED, 'unversioned nonempty Fusion database')
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
          CREATE TABLE artifacts (task_id TEXT NOT NULL REFERENCES tasks(id), digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(task_id, digest));
          CREATE TABLE documents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, checksum TEXT NOT NULL);
          PRAGMA user_version = 1;
          COMMIT;`)
      }
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    } catch (error) { this.#db.close(); throw error }
  }

  close(): void { this.#db.close() }

  listTaskIds(): readonly TaskId[] {
    return this.#db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row => {
      if (typeof row.id !== 'string') throw new FusionError(STORE_MIGRATION_REQUIRED, 'invalid task identity')
      return row.id as TaskId
    })
  }

  listDocumentIds(prefix: string): readonly string[] {
    return this.#db.prepare('SELECT id FROM documents WHERE substr(id, 1, ?) = ? ORDER BY id').all(prefix.length, prefix).map(row => {
      if (typeof row.id !== 'string') throw new FusionError(STORE_MIGRATION_REQUIRED, 'invalid document identity')
      return row.id
    })
  }

  load(taskId: TaskId): TaskState | undefined { return this.#read(taskId)?.persisted.state }

  events(taskId: TaskId): readonly FusionEvent[] { return this.#require(taskId).persisted.events }

  replay(taskId: TaskId): TaskState { return reduceAll(this.#require(taskId).persisted.events) }

  create(event: Extract<FusionEvent, { type: 'task/created' }>): TaskState {
    return this.#transaction(() => {
      if (this.#read(event.taskId)) throw new FusionError(EVENT_CONFLICT, 'task exists')
      const state = reduce(undefined, event)
      this.#write(event.taskId, { state, events: [event], outbox: [] }, [])
      return state
    })
  }

  transact(taskId: TaskId, expectedSeq: number, mutate: (current: PersistedTask) => {
    events?: readonly FusionEvent[]; outbox?: readonly OutboxRow[]
  }): TaskState {
    return this.#transaction(() => {
      const current = this.#require(taskId)
      if (current.persisted.state.seq !== expectedSeq) throw new FusionError(EVENT_CONFLICT, 'task sequence changed')
      const patch = mutate(structuredClone(current.persisted))
      return this.#apply(taskId, current, patch.events ?? [], patch.outbox ?? current.persisted.outbox)
    })
  }

  append(taskId: TaskId, expectedRevision: number, events: readonly FusionEvent[]): TaskState {
    return this.#transaction(() => {
      const current = this.#require(taskId)
      if (current.persisted.state.revision !== expectedRevision) throw new FusionError(REVISION_CONFLICT, 'task revision changed')
      return this.#apply(taskId, current, events, current.persisted.outbox)
    })
  }

  putArtifact(taskId: TaskId, bytes: Uint8Array, mediaType: string): ArtifactRef {
    return this.putArtifacts(taskId, [{ bytes, mediaType }])[0]
  }

  /** One atomic metadata update for a bounded workspace evidence batch. */
  putArtifacts(taskId: TaskId, inputs: readonly { bytes: Uint8Array; mediaType: string }[]): ArtifactRef[] {
    return this.#transaction(() => {
      const current = this.#require(taskId)
      const records = new Map(current.artifacts.map(record => [record.digest, record]))
      const insert = this.#db.prepare('INSERT OR IGNORE INTO artifacts(task_id, digest, bytes) VALUES (?, ?, ?)')
      const result = inputs.map(({ bytes, mediaType }) => {
        const digest = sha256Hex(bytes)
        const record: ArtifactRecord = {
          id: ArtifactId(digest), digest, ownerTaskId: taskId, mediaType, bytes: bytes.byteLength,
          storageRef: `sqlite:${taskId}:${digest}`,
        }
        insert.run(taskId, digest, bytes)
        records.set(digest, record)
        return record
      })
      this.#write(taskId, current.persisted, [...records.values()])
      return result
    })
  }

  /** Load owned evidence bytes and verify content before trusting the reference. */
  readArtifact(taskId: TaskId, digest: string): Uint8Array {
    return this.readArtifacts(taskId, [digest])[0]
  }

  readArtifacts(taskId: TaskId, digests: readonly string[]): Uint8Array[] {
    const records = new Map<string, ArtifactRecord>(this.artifacts(taskId).map(record => [record.digest, record]))
    const select = this.#db.prepare('SELECT bytes FROM artifacts WHERE task_id = ? AND digest = ?')
    return digests.map(digest => {
      const record = records.get(digest), row = select.get(taskId, digest)
      if (!record || !(row?.bytes instanceof Uint8Array)) throw new FusionError(EVENT_CONFLICT, 'artifact not owned by task')
      if (sha256Hex(row.bytes) !== digest || row.bytes.byteLength !== record.bytes) throw new FusionError(CHECKSUM_MISMATCH, 'corrupt artifact')
      return row.bytes
    })
  }

  prepareOutbox(row: OutboxRow): OutboxRow {
    return this.#transaction(() => {
      const current = this.#require(row.taskId)
      const existing = current.persisted.outbox.find(item => item.operationId === row.operationId)
      if (existing) return existing
      const prepared: OutboxRow = { ...row, state: 'prepared' }
      this.#write(row.taskId, { ...current.persisted, outbox: [...current.persisted.outbox, prepared] }, current.artifacts)
      return prepared
    })
  }

  advanceOutbox(taskId: TaskId, operationId: string, from: OutboxState, to: OutboxState, patch: Partial<OutboxRow> = {}): OutboxRow {
    return this.#transaction(() => {
      const current = this.#require(taskId)
      const prior = current.persisted.outbox.find(item => item.operationId === operationId)
      if (!prior || prior.state !== from) throw new FusionError(EVENT_CONFLICT, 'outbox state changed or missing')
      if ((patch.operationId !== undefined && patch.operationId !== prior.operationId)
        || (patch.taskId !== undefined && patch.taskId !== prior.taskId)) throw new FusionError(EVENT_CONFLICT, 'outbox identity is immutable')
      const next: OutboxRow = { ...prior, ...patch, state: to }
      this.#write(taskId, { ...current.persisted, outbox: current.persisted.outbox.map(item => item.operationId === operationId ? next : item) }, current.artifacts)
      return next
    })
  }

  outbox(taskId: TaskId): readonly OutboxRow[] { return this.#require(taskId).persisted.outbox }
  artifacts(taskId: TaskId): readonly ArtifactRecord[] { return this.#require(taskId).artifacts }

  /** Host binding / usage documents require caller-side schema validation after loading. */
  readDocument(id: string): { revision: number; value: unknown } | undefined {
    const row = this.#db.prepare('SELECT revision, json, checksum FROM documents WHERE id = ?').get(id)
    if (!row) return undefined
    if (typeof row.json !== 'string' || typeof row.revision !== 'number') throw new FusionError(STORE_MIGRATION_REQUIRED, 'invalid Host document')
    if (sha256Hex(Buffer.from(row.json)) !== row.checksum) throw new FusionError(CHECKSUM_MISMATCH, 'corrupt Host document')
    return { revision: row.revision, value: JSON.parse(row.json) as unknown }
  }

  /** Compare-and-swap prevents an old Host instance overwriting a newer selection or bill. */
  writeDocument(id: string, expectedRevision: number, value: unknown): number {
    return this.#transaction(() => this.#writeDocument(id, expectedRevision, value))
  }

  writeDocuments(rows: readonly { id: string; expectedRevision: number; value: unknown }[]): number[] {
    return this.#transaction(() => rows.map(row => this.#writeDocument(row.id, row.expectedRevision, row.value)))
  }

  #writeDocument(id: string, expectedRevision: number, value: unknown): number {
    const current = this.readDocument(id)
    if ((current?.revision ?? 0) !== expectedRevision) throw new FusionError(REVISION_CONFLICT, 'Host document revision changed')
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('Host document must be JSON serializable')
    const revision = expectedRevision + 1
    this.#db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, json=excluded.json, checksum=excluded.checksum')
      .run(id, revision, json, sha256Hex(Buffer.from(json)))
    return revision
  }

  #apply(taskId: TaskId, current: DiskSnapshot, events: readonly FusionEvent[], outbox: readonly OutboxRow[]): TaskState {
    let state = current.persisted.state
    const nextEvents = [...current.persisted.events]
    for (const event of events) {
      if (state.appliedEventIds.includes(event.id)) continue
      state = reduce(state, event)
      nextEvents.push(event)
    }
    this.#write(taskId, { state, events: nextEvents, outbox }, current.artifacts)
    return state
  }

  #read(taskId: TaskId): DiskSnapshot | undefined {
    const row = this.#db.prepare('SELECT snapshot FROM tasks WHERE id = ?').get(taskId)
    if (!row) return undefined
    if (typeof row.snapshot !== 'string') throw new FusionError(STORE_MIGRATION_REQUIRED, 'invalid task snapshot')
    return decodeStoreSnapshot(row.snapshot, taskId)
  }

  #require(taskId: TaskId): DiskSnapshot {
    const current = this.#read(taskId)
    if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`)
    return current
  }

  #write(taskId: TaskId, persisted: PersistedTask, artifacts: readonly ArtifactRecord[]): void {
    const snapshot: DiskSnapshot = { projectionVersion: STORE_PROJECTION_VERSION, persisted, artifacts, checksum: digestOf({ persisted, artifacts }) }
    this.#db.prepare('INSERT INTO tasks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(taskId, JSON.stringify(snapshot))
    const indexId = `task-index:${taskId}`
    const prior = this.readDocument(indexId), summary = taskSummary(persisted.state, persisted.events[0]!.createdAt, persisted.events.at(-1)!.createdAt)
    const priorTitle = (prior?.value as { title?: unknown } | undefined)?.title
    if (!persisted.state.currentWorkOrder && typeof priorTitle === 'string') summary.title = priorTitle
    this.#writeDocument(indexId, prior?.revision ?? 0, summary)
  }

  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const result = body(); this.#db.exec('COMMIT'); return result } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }
}
