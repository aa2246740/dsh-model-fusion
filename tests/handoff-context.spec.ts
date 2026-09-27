import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recentHandoffSuffix } from '../src/context/handoff.js'
import { workerHandoffProjection } from '../src/host/native-worker-brief.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { CHILD, TASK, created, envelope, order } from './helpers.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function setup(initial: string, feedback: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'fusion-handoff-')), filename = join(dir, 'state.sqlite')
  const store = new SqliteFusionStore(filename)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => store.close())
  store.create(created())
  store.append(TASK, 1, [envelope('work-order/prepared', 2, { order: order(), reservedChild: CHILD })])
  const payload = store.putArtifact(TASK, Buffer.from(initial), 'text/plain')
  store.prepareOutbox({ taskId: TASK, operationId: order().operationId, kind: 'native-worker',
    state: 'prepared', reservedChild: CHILD, payloadRef: payload.id })
  store.writeDocument(`runtime:${TASK}`, 0, { briefRevision: feedback.length })
  feedback.forEach((content, index) => {
    const artifact = store.putArtifact(TASK, Buffer.from(content), 'text/plain')
    store.writeDocument(`worker-delivery:${TASK}:${index}`, 0, { schemaVersion: 1, taskId: TASK,
      briefRevision: index + 1, payloadRef: artifact.id, causeId: `native-${index}`, state: 'accepted' })
  })
  return { store, filename, payload }
}

describe('whole-record handoff preservation', () => {
  it('handles empty input and retains an exactly fitting suffix', () => {
    expect(recentHandoffSuffix([])).toMatchObject({ omittedRecords: 0, retainedContentBytes: 0, records: [] })
    const records = [{ content: 'older' }, { content: 'a'.repeat(20_000) }, { content: 'b'.repeat(20_000) }]
    expect(recentHandoffSuffix(records)).toMatchObject({ omittedRecords: 1, retainedContentBytes: 40_000, records: records.slice(1) })
  })

  it('counts UTF-8 bytes and preserves complete multilingual records without slicing', () => {
    const records = [{ content: 'a'.repeat(1_001) }, { content: '中'.repeat(13_000) }]
    expect(recentHandoffSuffix(records)).toMatchObject({ omittedRecords: 1, retainedContentBytes: 39_000, records: [records[1]] })
    const exact = [{ content: 'a'.repeat(1_000) }, records[1]!]
    expect(recentHandoffSuffix(exact).records).toEqual(exact)
    const emoji = { content: '🙂'.repeat(10_001) + '\n保留整条' }
    expect(recentHandoffSuffix([records[0]!, emoji])).toMatchObject({ omittedRecords: 1, records: [emoji] })
  })

  it('always retains the oversized newest record and never skips a middle record to fill space', () => {
    const large = { content: 'x'.repeat(40_001) }
    expect(recentHandoffSuffix([{ content: 'older' }, large])).toMatchObject({ retainedContentBytes: 40_001, records: [large] })
    const records = [{ content: 'fits if wrongly skipped' }, large, { content: 'latest' }]
    expect(recentHandoffSuffix(records)).toMatchObject({ omittedRecords: 2, records: [records[2]] })
  })

  it('restores the initial handoff and provenance from its owned outbox', () => {
    const { store, payload } = setup('Details found only in the first Lead handoff.')
    expect(workerHandoffProjection(store, TASK)).toMatchObject({ totalRecords: 1, omittedRecords: 0,
      records: [{ revision: 0, source: 'lead-tool-handoff', sourceId: 'op-1', payloadRef: payload.id,
        content: 'Details found only in the first Lead handoff.' }] })
  })

  it('reopens the same suffix while all omitted original bytes and frozen conditions remain available', () => {
    const first = 'INITIAL ' + 'a'.repeat(30_000), older = 'OLDER ' + 'b'.repeat(30_000), latest = 'LATEST ' + '中'.repeat(9_000)
    const { store, filename, payload } = setup(first, [older, latest])
    const before = workerHandoffProjection(store, TASK)
    expect(before).toMatchObject({ totalRecords: 3, omittedRecords: 2, latestBriefRevision: 2,
      records: [{ revision: 2, content: latest }] })
    const reopened = new SqliteFusionStore(filename)
    cleanups.push(() => reopened.close())
    expect(workerHandoffProjection(reopened, TASK)).toEqual(before)
    expect(Buffer.from(reopened.readArtifact(TASK, payload.id)).toString('utf8')).toBe(first)
    expect(reopened.load(TASK)!.currentWorkOrder).toEqual(order())
    expect(reopened.listDocumentIds(`worker-delivery:${TASK}:`)).toHaveLength(2)
  })

  it('validates omitted history too, and refuses missing or foreign initial evidence', () => {
    const { store } = setup('old initial', ['old feedback', 'z'.repeat(40_001)])
    const row = store.readDocument(`worker-delivery:${TASK}:0`)!
    store.writeDocument(`worker-delivery:${TASK}:0`, row.revision, { ...(row.value as object), payloadRef: 'missing-omitted-artifact' })
    expect(() => workerHandoffProjection(store, TASK)).toThrow('artifact not owned')
    const other = setup('another initial')
    const state = other.store.load(TASK)!
    other.store.transact(TASK, state.seq, current => ({ outbox: current.outbox.map(row => ({ ...row, reservedChild: 'foreign-child' as typeof CHILD })) }))
    expect(() => workerHandoffProjection(other.store, TASK)).toThrow('requires reconciliation')
  })
})
