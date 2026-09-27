import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { OperationId, TaskId } from '../src/contracts.js'
import { created, envelope, TASK } from './helpers.js'

const dirs: string[] = []
const stores: SqliteFusionStore[] = []
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'fusion-sqlite-')); dirs.push(dir)
  return join(dir, 'runtime.sqlite')
}
function open(file = database()) {
  const store = new SqliteFusionStore(file); stores.push(store); return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('transactional Host persistence', () => {
  it('rejects stale writers across independent handles and preserves pause during reopen', () => {
    const file = database(); const first = open(file); first.create(created())
    const second = open(file)
    const stale = second.load(TASK)!
    first.transact(TASK, 1, () => ({ events: [envelope('task/paused', 2, { reason: 'user pause' })] }))
    expect(() => second.transact(TASK, stale.seq, () => ({ events: [] }))).toThrow('sequence changed')
    expect(open(file).load(TASK)?.control.mode).toBe('paused')
    expect(second.replay(TASK)).toEqual(first.load(TASK))
  })

  it('commits events and dispatch intent together; exceptions commit neither', () => {
    const store = open(); store.create(created())
    expect(() => store.transact(TASK, 1, () => { throw new Error('before dispatch') })).toThrow('before dispatch')
    expect(store.load(TASK)?.seq).toBe(1)
    const row = { operationId: OperationId('send-worker'), taskId: TASK, kind: 'worker', state: 'prepared' as const }
    store.transact(TASK, 1, () => ({ events: [envelope('task/paused', 2, { reason: 'pause' })], outbox: [row] }))
    expect(store.outbox(TASK)).toEqual([row])
    expect(store.load(TASK)?.control.mode).toBe('paused')
    store.advanceOutbox(TASK, row.operationId, 'prepared', 'dispatched')
    expect(() => store.advanceOutbox(TASK, row.operationId, 'prepared', 'accepted')).toThrow('state changed')
  })

  it('keeps evidence task-owned and verifies its bytes after process restart', () => {
    const file = database(); const store = open(file); store.create(created())
    const bytes = Buffer.from('native tool stdout')
    const artifact = store.putArtifact(TASK, bytes, 'text/plain')
    expect(Buffer.from(open(file).readArtifact(TASK, artifact.digest))).toEqual(bytes)
    expect(() => store.readArtifact(TaskId('another-task'), artifact.digest)).toThrow('unknown task')
    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE artifacts SET bytes=?').run(Buffer.from('tampered'))
    raw.close()
    expect(() => store.readArtifact(TASK, artifact.digest)).toThrow('corrupt artifact')
  })

  it('persists Host bindings and ledger documents with independent CAS', () => {
    const file = database(); const first = open(file); const second = open(file)
    first.writeDocument('session:lead', 0, { mode: 'paused', worker: 'persistent-worker', pendingApprovals: ['a'] })
    expect(second.readDocument('session:lead')?.value).toMatchObject({ mode: 'paused', pendingApprovals: ['a'] })
    expect(() => second.writeDocument('session:lead', 0, { mode: 'running' })).toThrow('revision changed')
    const read = second.readDocument('session:lead')!
    ;(read.value as { mode: string }).mode = 'running'
    expect(first.readDocument('session:lead')?.value).toMatchObject({ mode: 'paused' })
  })

  it('batches owned content atomically and reads duplicates in caller order after reopen', () => {
    const file = database(), store = open(file); store.create(created())
    const a = { bytes: Buffer.from('a'), mediaType: 'text/plain' }, b = { bytes: Buffer.from('b'), mediaType: 'text/plain' }
    const refs = store.putArtifacts(TASK, [a, b, a])
    expect(store.artifacts(TASK)).toHaveLength(2)
    expect(open(file).readArtifacts(TASK, refs.map(ref => ref.id)).map(bytes => Buffer.from(bytes).toString())).toEqual(['a', 'b', 'a'])
    const other = TaskId('other'); store.create(created(other))
    expect(() => store.readArtifacts(other, [refs[0].id])).toThrow('not owned')
    expect(() => store.putArtifacts(TASK, [
      { bytes: Buffer.from('must-roll-back'), mediaType: 'text/plain' },
      { bytes: null as unknown as Uint8Array, mediaType: 'text/plain' },
    ])).toThrow()
    expect(open(file).artifacts(TASK)).toHaveLength(2)
    const raw = new DatabaseSync(file)
    expect(raw.prepare('SELECT count(*) AS n FROM artifacts').get()?.n).toBe(2)
    raw.close()
  })

  it('refuses unknown database versions without rewriting them', () => {
    const file = database(); const raw = new DatabaseSync(file)
    raw.exec('PRAGMA user_version=93'); raw.close()
    expect(() => new SqliteFusionStore(file)).toThrow('unknown Fusion database version')
    const check = new DatabaseSync(file)
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(93)
    check.close()
  })
})
