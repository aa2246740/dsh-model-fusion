import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationId } from '../src/contracts.js'
import { CHECKSUM_MISMATCH, EVENT_CONFLICT, FLUSH_FAILED, REVISION_CONFLICT, STORE_MIGRATION_REQUIRED } from '../src/errors.js'
import { FileFusionStore, failingRenameIo, nodeIo, STORE_PROJECTION_VERSION } from '../src/task/store.js'
import { digestOf } from '../src/digest.js'
import { CHILD, TASK, created, envelope, expectCode } from './helpers.js'

const dirs: string[] = []

function store(io = nodeIo): FileFusionStore {
  const dir = mkdtempSync(join(tmpdir(), 'dmf-store-'))
  dirs.push(dir)
  return new FileFusionStore(dir, io)
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('FileFusionStore', () => {
  it('atomically appends events and updates the projection', () => {
    const db = store()
    db.create(created())
    const next = db.append(TASK, 1, [envelope('intent/chosen', 2, { intent: 'DIRECT' })])
    expect(next.phase).toBe('DIRECT')
    expect(db.replay(TASK)).toEqual(next)
  })

  it('is idempotent on duplicate event ids', () => {
    const db = store()
    db.create(created())
    const event = envelope('intent/chosen', 2, { intent: 'DIRECT' })
    db.append(TASK, 1, [event])
    const again = db.append(TASK, 1, [event])
    expect(again.seq).toBe(2)
  })

  it('rejects a stale revision CAS', () => {
    const db = store()
    db.create(created())
    db.append(TASK, 1, [envelope('requirements/revised', 2, { reason: 'x' }, { revision: 2 })])
    expectCode(
      () => db.append(TASK, 1, [envelope('intent/chosen', 3, { intent: 'DIRECT' }, { revision: 2 })]),
      REVISION_CONFLICT,
    )
  })

  it('does not advance memory past a failed flush', () => {
    const db = store(failingRenameIo(nodeIo))
    expectCode(() => db.create(created()), FLUSH_FAILED)
    expect(db.load(TASK)).toBeUndefined()
  })

  it('refuses a snapshot whose checksum was corrupted', () => {
    const db = store()
    db.create(created())
    const path = join(db.root, 'tasks', TASK, 'snapshot.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { checksum: string }
    raw.checksum = '0'.repeat(64)
    const broken = store()
    broken.io.writeFileSync = nodeIo.writeFileSync
    nodeIo.writeFileSync(path, `${JSON.stringify(raw)}\n`)
    const reader = new FileFusionStore(db.root)
    expectCode(() => reader.load(TASK), CHECKSUM_MISMATCH)
  })

  it('records artifacts only after the rename, leaving orphans harmless', () => {
    const db = store()
    db.create(created())
    const ref = db.putArtifact(TASK, Buffer.from('hello'), 'text/plain')
    expect(ref.bytes).toBe(5)
    expect(db.artifacts(TASK)[0]?.digest).toBe(ref.digest)
  })

  it('transacts ticket plus outbox against expected seq, not only revision', () => {
    const db = store()
    db.create(created())
    db.append(TASK, 1, [envelope('intent/chosen', 2, { intent: 'DIRECT' })])
    const next = db.transact(TASK, 2, current => ({
      events: [envelope('task/paused', 3, { reason: 'user' })],
      outbox: [...current.outbox, {
        operationId: OperationId('review-1'),
        taskId: TASK,
        kind: 'review-request',
        state: 'prepared',
      }],
    }))
    expect(next.phase).toBe('PAUSED')
    expect(db.outbox(TASK)[0]?.kind).toBe('review-request')
    expectCode(
      () => db.transact(TASK, 2, () => ({ events: [] })),
      EVENT_CONFLICT,
    )
  })

  it('writes projectionVersion 2 and refuses a checksum-valid v1 snapshot', () => {
    const db = store()
    db.create(created())
    const path = join(db.root, 'tasks', TASK, 'snapshot.json')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { projectionVersion: number; persisted: unknown; artifacts: unknown }
    expect(raw.projectionVersion).toBe(STORE_PROJECTION_VERSION)
    const legacy = {
      checksum: digestOf({ persisted: raw.persisted, artifacts: raw.artifacts }),
      persisted: raw.persisted,
      artifacts: raw.artifacts,
    }
    nodeIo.writeFileSync(path, `${JSON.stringify(legacy)}\n`)
    expectCode(() => new FileFusionStore(db.root).load(TASK), STORE_MIGRATION_REQUIRED)
  })

  it('returns the existing outbox row for a repeated operationId', () => {
    const db = store()
    db.create(created())
    const row = {
      operationId: OperationId('op-1'),
      taskId: TASK,
      kind: 'delegate',
      state: 'prepared' as const,
      reservedChild: CHILD,
    }
    expect(db.prepareOutbox(row).state).toBe('prepared')
    expect(db.prepareOutbox({ ...row, reservedChild: undefined }).reservedChild).toBe(CHILD)
    const accepted = db.advanceOutbox(TASK, 'op-1', 'prepared', 'accepted', { nativeMessageId: 'm1' })
    expect(accepted.nativeMessageId).toBe('m1')
  })
})
