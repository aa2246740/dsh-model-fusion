import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureExploration } from '../src/host/native-exploration.js'
import { snapshotWorkspace } from '../src/host/workspace.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { reduceAll } from '../src/task/reducer.js'
import { CHILD, created, envelope, order, TASK } from './helpers.js'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fusion-exploration-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'a.ts'), 'export function add(a, b) {\n  return a - b\n}\n')
  symlinkSync('a.ts', join(root, 'alias.ts'))
  const store = new SqliteFusionStore(':memory:')
  cleanup.push(() => store.close())
  store.create(created())
  const snapshot = snapshotWorkspace(root)
  const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
  const submitted = { status: 'completed' as const, summary: 'The function subtracts.', unresolved: [] }
  return { root, store, snapshot, work, submitted }
}
describe('source-backed exploration evidence', () => {
  it.each([
    { path: '../escape.ts', startLine: 1, endLine: 2 },
    { path: 'alias.ts', startLine: 1, endLine: 2 },
    { path: 'a.ts', startLine: 0, endLine: 2 },
    { path: 'a.ts', startLine: 1, endLine: 99 },
    { path: 'missing.ts', startLine: 1, endLine: 2 },
  ])('rejects an unbacked or invalid range: %j', source => {
    const { store, snapshot, work, submitted } = fixture()
    expect(() => captureExploration(store, work, snapshot, submitted, [source])).toThrow()
    expect(store.artifacts(TASK)).toEqual([])
  })
  it('refuses changed source bytes even with the original snapshot supplied', () => {
    const { root, store, snapshot, work, submitted } = fixture()
    writeFileSync(join(root, 'a.ts'), 'changed\n')
    expect(() => captureExploration(store, work, snapshot, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])).toThrow('changed during capture')
  })
  it('records a planning result with captured bytes but cannot complete or accept implementation', () => {
    const { store, snapshot, work, submitted } = fixture()
    const report = captureExploration(store, work, snapshot, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])
    expect(Buffer.from(store.readArtifact(TASK, report.sources[0]!.excerpt.id)).toString()).toContain('return a - b')
    const events = [created(), envelope('intent/chosen', 2, { intent: 'DELEGATE' }),
      envelope('work-order/prepared', 3, { order: work, reservedChild: CHILD }),
      envelope('child/accepted', 4, { operationId: work.operationId, child: CHILD, messageId: 'm1' }),
      envelope('exploration/recorded', 5, { report })]
    expect(reduceAll(events)).toMatchObject({ phase: 'PLANNING', verification: 'unverified', control: { mode: 'running' } })
    expect(() => reduceAll([...events, envelope('task/completed', 6, { snapshot: snapshot.id, verification: 'verified' })])).toThrow()
    expect(() => reduceAll([...events.slice(0, 4), envelope('exploration/recorded', 5, { report: { ...report, revision: 2 } })])).toThrow()
  })
})
