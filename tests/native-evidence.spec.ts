import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationId, TaskId } from '../src/contracts.js'
import { digestOf } from '../src/digest.js'
import { readNativeEvidence } from '../src/host/native-evidence.js'
import { evidencePage } from '../src/host/evidence-page.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { created, PARENT, SNAP, TASK } from './helpers.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fusion-receipt-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'state.sqlite'), store = new SqliteFusionStore(file)
  cleanup.push(() => store.close()); store.create(created())
  const callId = 'fusion-check-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', id = `receipt:${callId}`
  const key = `check-invocation:${TASK}:${callId}`
  const stdout = store.putArtifact(TASK, Buffer.from(''), 'text/plain')
  const stderr = store.putArtifact(TASK, Buffer.from('Ran 1 test in 0.1s\nOK\n'), 'text/plain')
  const plan = { taskId: TASK, argvDigest: digestOf('python3 -m unittest'), cwdDigest: digestOf(root) }
  const evidence = { schemaVersion: 1, taskId: TASK, operationId: OperationId(callId), actor: PARENT,
    nativeToolCallId: callId, argvDigest: plan.argvDigest, cwdDigest: plan.cwdDigest,
    inputSnapshot: SNAP, outputSnapshot: SNAP, state: 'completed', exitCode: 0,
    startedAt: '2026-09-23T00:00:00Z', endedAt: '2026-09-23T00:00:01Z', stdout, stderr }
  const record = { check: { plan, definition: { command: 'python3 -m unittest', description: '原生检查 🧪' } }, evidence,
    receipt: { id, planDigest: digestOf(plan), evidence: structuredClone(evidence), counts: { executed: 1, passed: 1, failed: 0 } } }
  store.writeDocument(key, 0, record)
  const replace = () => store.writeDocument(key, store.readDocument(key)!.revision, record)
  return { store, file, id, key, record, replace }
}

describe('owned native check receipt reads', () => {
  it('survives reopening and pages exact receipt JSON without mutating the ledger', () => {
    const { store, file, id, key, record } = fixture(), before = store.readDocument(key)
    const reopened = new SqliteFusionStore(file); cleanup.push(() => reopened.close())
    const bytes = readNativeEvidence(reopened, TASK, id)
    let offset = 0, text = ''
    for (;;) {
      const page = evidencePage(bytes, offset, 17); text += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    }
    expect(JSON.parse(text)).toEqual({ kind: 'check-receipt', check: record.check, receipt: record.receipt })
    expect(Buffer.from(readNativeEvidence(reopened, TASK, record.evidence.stderr.id)).toString()).toContain('Ran 1 test')
    expect(store.readDocument(key)).toEqual(before)
  })

  it('keeps failed check results readable without converting them to acceptance', () => {
    const { store, id, record, replace } = fixture()
    record.evidence.exitCode = 1; record.receipt.evidence = structuredClone(record.evidence)
    record.receipt.counts = { executed: 1, passed: 0, failed: 1 }; replace()
    expect(JSON.parse(Buffer.from(readNativeEvidence(store, TASK, id)).toString()).receipt).toMatchObject({
      counts: { failed: 1 }, evidence: { exitCode: 1 },
    })
  })

  it('rejects foreign tasks, forged scope and incomplete invocations', () => {
    const { store, id, key, record, replace } = fixture(), foreign = TaskId('foreign')
    store.create(created(foreign))
    expect(() => readNativeEvidence(store, foreign, id)).toThrow('unavailable or invalid')
    store.writeDocument(key.replace(TASK, foreign), 0, record)
    expect(() => readNativeEvidence(store, foreign, id)).toThrow('unavailable or invalid')
    record.receipt.evidence.exitCode = 1; replace()
    expect(() => readNativeEvidence(store, TASK, id)).toThrow('unavailable or invalid')
    store.writeDocument(key, store.readDocument(key)!.revision, { check: record.check, evidence: record.evidence })
    expect(() => readNativeEvidence(store, TASK, id)).toThrow('unavailable or invalid')
    expect(() => readNativeEvidence(store, TASK, 'receipt:settings:authorization')).toThrow('Invalid native')
  })

  it('rejects corrupt output references and changed check plans', () => {
    const { store, id, record, replace } = fixture()
    record.evidence.stderr.bytes++; record.receipt.evidence = structuredClone(record.evidence); replace()
    expect(() => readNativeEvidence(store, TASK, id)).toThrow('length')
    record.evidence.stderr.ownerTaskId = TaskId('foreign'); record.receipt.evidence = structuredClone(record.evidence); replace()
    expect(() => readNativeEvidence(store, TASK, id)).toThrow('ownership')
    record.check.plan.argvDigest = digestOf('another command'); replace()
    expect(() => readNativeEvidence(store, TASK, id)).toThrow('unavailable or invalid')
  })
})
