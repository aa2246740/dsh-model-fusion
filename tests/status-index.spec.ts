import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { sha256Hex } from '../src/digest.js'
import { newLedger, ingestDurable } from '../src/usage/ledger.js'
import { billFromNativeUsage, type NativeUsageRecord } from '../src/host/native-usage.js'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { TaskId } from '../src/contracts.js'

const clean: (() => void)[] = []
afterEach(() => clean.splice(0).reverse().forEach(fn => fn()))
function open(file?: string) {
  if (!file) { const dir = mkdtempSync(join(tmpdir(), 'fusion-index-')); clean.push(() => rmSync(dir, { recursive: true, force: true })); file = join(dir, 'state.sqlite') }
  const store = new SqliteFusionStore(file); clean.push(() => store.close()); return store
}
function raw(file: string) { const db = new DatabaseSync(file); clean.push(() => db.close()); return db }
function row(id: string, tokens?: number, mode: 'snapshot' | 'final' = 'final'): NativeUsageRecord {
  const key = { provider: 'p', model: 'm', requestId: id, attemptId: id, contractDigest: 'd' }
  let ledger = newLedger(key)
  if (tokens !== undefined) ledger = ingestDurable(ledger, { id: 'observation', key, sequence: 1, mode, bill: billFromNativeUsage({ inputTokens: tokens, outputTokens: 0 }) })
  return { schemaVersion: 1, taskId: TaskId('t'), sessionId: 's', role: 'worker', purpose: 'conversation', nativeInvocationId: id,
    maxOutputTokens: 32, startedAt: '2026-10-13T00:00:00Z', endedAt: null, nativeStreamInvocations: 1, upstreamHttpCalls: null,
    outcome: 'entered', ledger, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null }
}
const read = (store: SqliteFusionStore) => store.statusSnapshot(index => index.read('t'))
function put(db: DatabaseSync, id: string, value: unknown, revision = 1) {
  const json = JSON.stringify(value)
  db.prepare('INSERT INTO documents VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,checksum=excluded.checksum,revision=excluded.revision')
    .run(id, revision, json, sha256Hex(Buffer.from(json)))
}

describe('incremental status read model', () => {
  it('replaces snapshots/finals without double counting, keeps unknown counts, and rejects stale writers atomically', () => {
    const store = open(), other = open(store.filename), id = 'usage:t:a'
    store.writeDocument(id, 0, row('a'))
    expect(read(other).usage).toMatchObject({ calls: 1, unreportedCalls: 1, input: { reportedRequests: 0, knownTokens: 0, totalRequests: 1 } })
    store.writeDocument(id, 1, row('a', 20, 'snapshot'))
    expect(read(other).usage).toMatchObject({ calls: 1, provisionalCalls: 1, unreportedCalls: 0, input: { knownTokens: 20 } })
    store.writeDocument(id, 2, row('a', 10))
    store.writeDocument(id, 3, row('a', 10))
    expect(read(other).usage).toMatchObject({ calls: 1, finalCalls: 1, provisionalCalls: 0, input: { knownTokens: 10 }, output: { reportedRequests: 1, knownTokens: 0 }, cacheRead: { reportedRequests: 0 } })
    expect(() => other.writeDocuments([{ id: 'usage:t:b', expectedRevision: 0, value: row('b', 50) }, { id, expectedRevision: 3, value: row('a', 100) }])).toThrow('revision changed')
    expect(other.readDocument('usage:t:b')).toBeUndefined(); expect(read(other).usage.calls).toBe(1)
    expect(read(store)).toEqual(read(other))
  })

  it('tracks old-process raw writes, id replacement, deletion and recreation without stale totals', () => {
    const store = open(), db = raw(store.filename)
    put(db, 'usage:t:a', row('a', 3)); expect(read(store).usage.input.knownTokens).toBe(3)
    put(db, 'usage:t:a', row('a', 7), 2); expect(read(store).usage.input.knownTokens).toBe(7)
    db.exec("UPDATE documents SET id='usage:t:b' WHERE id='usage:t:a'")
    expect(read(store).usage.calls).toBe(1); expect(read(store).requests[0].id).toBe('usage:t:b')
    db.exec('DELETE FROM documents'); expect(read(store).usage.calls).toBe(0)
    put(db, 'usage:t:a', row('a', 9)); expect(read(store).usage.input.knownTokens).toBe(9)
    store.statusSnapshot(index => index.rebuild()); expect(read(store).usage.input.knownTokens).toBe(9)
  })

  it('upgrades an old database with bounded dirty batches and rebuilds missing derived tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fusion-legacy-')); clean.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'legacy.sqlite'), db = raw(file)
    db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,json TEXT NOT NULL,checksum TEXT NOT NULL); PRAGMA user_version=1;')
    for (let i = 0; i < 600; i++) put(db, `usage:t:${i}`, row(String(i), 2))
    const store = open(file)
    expect(store.statusSnapshot(index => index.flushBatch('t'))).toBe(true)
    expect(db.prepare('SELECT count(*) n FROM fusion_status_dirty_v1').get()?.n).toBe(344)
    // A later batch failure must preserve the committed prefix, and retry must not double count it.
    db.exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON fusion_status_facts_v1 BEGIN SELECT RAISE(ABORT,'injected backfill failure'); END")
    expect(() => read(store)).toThrow('injected backfill failure')
    expect(db.prepare('SELECT count(*) n FROM fusion_status_facts_v1').get()?.n).toBe(256)
    db.exec('DROP TRIGGER fail_backfill')
    expect(read(store).usage).toMatchObject({ calls: 600, input: { knownTokens: 1200 } }); expect(read(store).requests).toHaveLength(12)
    expect(db.prepare('SELECT count(*) n FROM fusion_status_dirty_v1').get()?.n).toBe(0)
    db.exec('DROP TABLE fusion_status_totals_v1')
    const reopened = open(file); expect(read(reopened).usage.input.knownTokens).toBe(1200)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
  })

  it('yields during backfill, safely cancels, and resumes from committed progress in another store', async () => {
    const store = open(), db = raw(store.filename)
    for (let i = 0; i < 600; i++) put(db, `usage:t:${i}`, row(String(i), 2))
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    await expect(store.statusSnapshotAsync(index => index.read('t'), abort.signal)).rejects.toThrow()
    expect(db.prepare('SELECT count(*) n FROM fusion_status_facts_v1').get()?.n).toBe(256)
    expect(db.prepare('SELECT count(*) n FROM fusion_status_dirty_v1').get()?.n).toBe(344)
    const other = open(store.filename)
    const [a, b] = await Promise.all([store.statusSnapshotAsync(index => index.read('t')), other.statusSnapshotAsync(index => index.read('t'))])
    expect(a).toEqual(b); expect(a.usage).toMatchObject({ calls: 600, input: { knownTokens: 1200 } })
  })

  it('rebuilds after a missing trigger allowed an old writer to bypass invalidation', () => {
    const store = open(), db = raw(store.filename)
    store.writeDocument('usage:t:a', 0, row('a', 2))
    db.exec('DROP TRIGGER fusion_status_update_v1')
    put(db, 'usage:t:a', row('a', 7), 2)
    const reopened = open(store.filename)
    expect(read(reopened).usage.input.knownTokens).toBe(7)
    expect(read(store)).toEqual(read(reopened))
  })

  it('keeps recent previews, latest contexts and effect/check transitions bounded and complete', () => {
    const store = open()
    for (let i = 0; i < 30; i++) store.writeDocument(`usage:t:${String(i).padStart(2, '0')}`, 0, { ...row(String(i)), startedAt: new Date(i * 1000).toISOString() })
    store.writeDocument('native-effect:t:e', 0, { schemaVersion: 1, taskId: 't', role: 'worker', toolName: 'shell', state: 'dispatch-started', startedAt: 'now', arguments: { secret: 'must-not-expose' } })
    store.writeDocument('check-invocation:t:c', 0, { evidence: { taskId: 't', state: 'started' } })
    for (const role of ['lead', 'worker']) for (let i = 0; i < 3; i++) store.writeDocument(`context-request:t:${role}${i}`, 0, { schemaVersion: 1, taskId: 't', role, purpose: 'conversation', checkedAt: String(i), measurement: { inputTokens: i, quality: 'heuristic' }, budget: 50, admitted: true })
    const value = read(store)
    expect(value).toMatchObject({ checking: true, unsettledTools: 1 }); expect(value.requests[0].id).toBe('usage:t:29'); expect(value.requests).toHaveLength(12)
    expect(value.contexts.map(v => v.inputTokens)).toEqual([2, 2]); expect(JSON.stringify(value)).not.toContain('must-not-expose')
    store.writeDocument('check-invocation:t:c', 1, { evidence: { taskId: 't', state: 'done' } })
    store.writeDocument('native-effect:t:e', 1, { schemaVersion: 1, taskId: 't', role: 'worker', toolName: 'shell', state: 'returned', startedAt: 'now' })
    expect(read(store)).toMatchObject({ checking: false, unsettledTools: 0 })
    expect(store.statusSnapshot(index => index.hasConversation('t', 's'))).toBe(true)
    expect(store.statusSnapshot(index => index.workerConversations('t'))).toBe(30)
  })

  it('detects corrupt source updates and isolates another task from malformed records', () => {
    const store = open(), db = raw(store.filename)
    store.writeDocument('usage:t:a', 0, row('a', 1))
    db.exec("UPDATE documents SET json='{}' WHERE id='usage:t:a'")
    expect(() => read(store)).toThrow('corrupt Host document')
    expect(db.prepare('SELECT count(*) n FROM fusion_status_dirty_v1').get()?.n).toBe(0)
    expect(store.statusSnapshot(index => index.read('other')).usage.calls).toBe(0)
    put(db, 'usage:t:a', row('a', 2), 2)
    expect(read(store).usage.input.knownTokens).toBe(2)
  })
  it('reads a whole committed batch while another process connection writes', async () => {
    const store = open()
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const {createHash}=require('node:crypto');
      const db=new DatabaseSync(workerData.file); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const put=db.prepare('INSERT INTO documents VALUES (?,1,?,?)');
      for(const [id,row] of workerData.rows){const json=JSON.stringify(row);put.run(id,json,createHash('sha256').update(json).digest('hex'))}
      parentPort.postMessage('locked');
      setTimeout(()=>{db.exec('COMMIT');db.close()},50);
    `, { eval: true, workerData: { file: store.filename, rows: [['usage:t:a', row('a', 3)], ['usage:t:b', row('b', 7)]] } })
    try {
      await once(worker, 'message')
      expect(read(store).usage).toMatchObject({ calls: 2, input: { knownTokens: 10, reportedRequests: 2 } })
    } finally { await worker.terminate() }
  })

})
