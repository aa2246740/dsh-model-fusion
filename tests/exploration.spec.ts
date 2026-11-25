import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureExploration, scopeDirectoryEmpty } from '../src/host/native-exploration.js'
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
  ])('rejects an unbacked or invalid range: %j', (source: { path: string; startLine: number; endLine: number }) => {
    const { store, snapshot, work, submitted } = fixture()
    expect(() => captureExploration(store, work, snapshot, snapshot, submitted, [source])).toThrow()
    expect(store.artifacts(TASK)).toEqual([])
  })
  it('refuses changed source bytes even with the original snapshot supplied', () => {
    const { root, store, snapshot, work, submitted } = fixture()
    writeFileSync(join(root, 'a.ts'), 'changed\n')
    expect(() => captureExploration(store, work, snapshot, snapshot, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])).toThrow('changed during capture')
  })
  it('records a completed report when an uncited file changes and keeps the frozen baseline id', () => {
    const { root, store, snapshot, work, submitted } = fixture()
    writeFileSync(join(root, 'other.md'), 'unrelated\n')
    const current = snapshotWorkspace(root)
    expect(current.id).not.toBe(snapshot.id)
    const report = captureExploration(store, work, snapshot, current, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.status).toBe('completed')
    expect(Buffer.from(store.readArtifact(TASK, report.sources[0]!.excerpt.id)).toString()).toContain('return a - b')
  })
  it('rejects a completed report that cites a changed file and names both snapshots', () => {
    const { root, store, snapshot, work, submitted } = fixture()
    writeFileSync(join(root, 'a.ts'), 'export function add(a, b) {\n  return a + b\n}\n')
    const current = snapshotWorkspace(root)
    expect(() => captureExploration(store, work, snapshot, current, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])).toThrow(`Frozen baseline ${snapshot.id}`)
    expect(store.artifacts(TASK)).toEqual([])
  })
  it('records a blocked report when the workspace drifted, including the drift detail', () => {
    const { root, store, snapshot, work } = fixture()
    writeFileSync(join(root, 'other.md'), 'unrelated\n')
    const current = snapshotWorkspace(root)
    const blocked = { status: 'blocked' as const, summary: 'Could not prove the tree was stable.', unresolved: ['need a decision'] }
    const report = captureExploration(store, work, snapshot, current, blocked, [])
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.status).toBe('blocked')
    expect(report.unresolved.join('\n')).toContain(current.id)
    expect(report.unresolved.join('\n')).toContain('other.md')
    expect(report.sources).toEqual([])
  })
  it('records a needs-decision report even when a cited file no longer matches', () => {
    const { root, store, snapshot, work } = fixture()
    writeFileSync(join(root, 'a.ts'), 'changed\n')
    const current = snapshotWorkspace(root)
    const report = captureExploration(store, work, snapshot, current, { status: 'needs-decision', summary: 'The cited file moved.', unresolved: [] }, [{ path: 'a.ts', startLine: 1, endLine: 1 }])
    expect(report.status).toBe('needs-decision')
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.unresolved.join('\n')).toContain('changed during capture')
    expect(report.sources).toEqual([])
  })
  it('accepts one cited range on a non-empty workspace', () => {
    const { store, snapshot, work, submitted } = fixture()
    const report = captureExploration(store, work, snapshot, snapshot, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])
    expect(report.status).toBe('completed')
    expect(report.sources).toHaveLength(1)
  })

  it('rejects 13 source ranges', () => {
    const { store, snapshot, work, submitted } = fixture()
    const sources = Array.from({ length: 13 }, () => ({ path: 'a.ts', startLine: 1, endLine: 2 }))
    expect(() => captureExploration(store, work, snapshot, snapshot, submitted, sources)).toThrow('A completed exploration requires 1–12 source ranges')
    expect(store.artifacts(TASK)).toEqual([])
  })

  it('rejects zero ranges on a non-empty workspace even when the summary claims the scope is empty', () => {
    const { store, snapshot, work } = fixture()
    const claimed = { status: 'completed' as const, summary: 'The scope is empty and has no files.', unresolved: [] }
    expect(() => captureExploration(store, work, snapshot, snapshot, claimed, [])).toThrow('A completed exploration requires 1–12 source ranges')
    expect(store.artifacts(TASK)).toEqual([])
  })

  it('accepts a completed report with zero ranges when the host listing is empty and the summary says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-exploration-empty-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const store = new SqliteFusionStore(':memory:')
    cleanup.push(() => store.close())
    store.create(created())
    const snapshot = snapshotWorkspace(root)
    expect(snapshot.entries).toEqual([])
    const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
    const submitted = { status: 'completed' as const, summary: 'The scope is empty. The directory has no files.', unresolved: [] as string[] }
    const report = captureExploration(store, work, snapshot, snapshot, submitted, [])
    expect(report.status).toBe('completed')
    expect(report.sources).toEqual([])
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.summary).toContain('no files')
    expect(report.summary).toContain('Host verified: the workspace listing contains no files.')
    const stated = { status: 'completed' as const, summary: '调查范围没有文件。', unresolved: [] as string[] }
    const chinese = captureExploration(store, work, snapshot, snapshot, stated, [])
    expect(chinese.status).toBe('completed')
    expect(chinese.sources).toEqual([])
  })

  it('rejects zero ranges on an empty listing when the summary does not state that the scope is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-exploration-empty-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const store = new SqliteFusionStore(':memory:')
    cleanup.push(() => store.close())
    store.create(created())
    const snapshot = snapshotWorkspace(root)
    const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
    const submitted = { status: 'completed' as const, summary: 'Finished the listing.', unresolved: [] }
    expect(() => captureExploration(store, work, snapshot, snapshot, submitted, [])).toThrow('summary states that the scope is empty')
    expect(store.artifacts(TASK)).toEqual([])
  })

  it('rejects zero ranges when the live listing could not be taken or is no longer empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-exploration-empty-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const store = new SqliteFusionStore(':memory:')
    cleanup.push(() => store.close())
    store.create(created())
    const snapshot = snapshotWorkspace(root)
    const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
    const submitted = { status: 'completed' as const, summary: 'The scope is empty and has no files.', unresolved: [] }
    expect(() => captureExploration(store, work, snapshot, undefined, submitted, [], 'Unsupported source file type: unrelated.pipe')).toThrow('A completed exploration requires 1–12 source ranges')
    writeFileSync(join(root, 'later.ts'), 'export const n = 1\n')
    const current = snapshotWorkspace(root)
    expect(current.entries.length).toBeGreaterThan(0)
    expect(() => captureExploration(store, work, snapshot, current, submitted, [])).toThrow('A completed exploration requires 1–12 source ranges')
    expect(store.artifacts(TASK)).toEqual([])
  })

  it('rejects zero ranges when the filtered manifest is empty but the directory still has entries', () => {
    const submitted = { status: 'completed' as const, summary: 'The scope is empty and has no files.', unresolved: [] as string[] }
    const open = (root: string, manifestEmpty: boolean) => {
      const store = new SqliteFusionStore(':memory:')
      cleanup.push(() => store.close())
      store.create(created())
      const snapshot = snapshotWorkspace(root)
      if (manifestEmpty) expect(snapshot.entries).toEqual([])
      const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
      expect(scopeDirectoryEmpty(snapshot.root)).toBe(false)
      expect(() => captureExploration(store, work, snapshot, snapshot, submitted, [])).toThrow('A completed exploration requires 1–12 source ranges')
      expect(store.artifacts(TASK)).toEqual([])
    }
    const hidden = mkdtempSync(join(tmpdir(), 'fusion-exploration-hidden-'))
    cleanup.push(() => rmSync(hidden, { recursive: true, force: true }))
    writeFileSync(join(hidden, '.hidden.ts'), 'export const a = 1\n')
    open(hidden, false)

    const ignored = mkdtempSync(join(tmpdir(), 'fusion-exploration-ignored-'))
    cleanup.push(() => rmSync(ignored, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', ignored])
    writeFileSync(join(ignored, '.gitignore'), 'scope/**\n')
    const scope = join(ignored, 'scope')
    mkdirSync(scope)
    writeFileSync(join(scope, 'secret.ts'), 'export const a = 1\n')
    open(scope, true)

    const excluded = mkdtempSync(join(tmpdir(), 'fusion-exploration-excluded-'))
    cleanup.push(() => rmSync(excluded, { recursive: true, force: true }))
    mkdirSync(join(excluded, 'node_modules'))
    writeFileSync(join(excluded, 'node_modules', 'actual.js'), 'export const a = 1\n')
    open(excluded, true)

    const repo = mkdtempSync(join(tmpdir(), 'fusion-exploration-git-'))
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }))
    execFileSync('git', ['init', '-q', repo])
    open(repo, true)
  })

  it('rejects a stale empty manifest once a file exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-exploration-late-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const store = new SqliteFusionStore(':memory:')
    cleanup.push(() => store.close())
    store.create(created())
    const snapshot = snapshotWorkspace(root)
    const work = { ...order(), mode: 'explore' as const, baseSnapshot: snapshot.id, allowedPaths: [], acceptance: [] }
    const submitted = { status: 'completed' as const, summary: 'The scope is empty and has no files.', unresolved: [] }
    expect(captureExploration(store, work, snapshot, snapshot, submitted, []).sources).toEqual([])
    writeFileSync(join(root, 'appeared.ts'), 'export const a = 1\n')
    expect(scopeDirectoryEmpty(snapshot.root)).toBe(false)
    expect(() => captureExploration(store, work, snapshot, snapshot, submitted, [])).toThrow('A completed exploration requires 1–12 source ranges')
  })

  it('records a planning result with captured bytes but cannot complete or accept implementation', () => {
    const { store, snapshot, work, submitted } = fixture()
    const report = captureExploration(store, work, snapshot, snapshot, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }])
    expect(Buffer.from(store.readArtifact(TASK, report.sources[0]!.excerpt.id)).toString()).toContain('return a - b')
    const events = [created(), envelope('intent/chosen', 2, { intent: 'DELEGATE' }),
      envelope('work-order/prepared', 3, { order: work, reservedChild: CHILD }),
      envelope('child/accepted', 4, { operationId: work.operationId, child: CHILD, messageId: 'm1' }),
      envelope('exploration/recorded', 5, { report })]
    expect(reduceAll(events)).toMatchObject({ phase: 'PLANNING', verification: 'unverified', control: { mode: 'running' } })
    expect(() => reduceAll([...events, envelope('task/completed', 6, { snapshot: snapshot.id, verification: 'verified' })])).toThrow()
    expect(() => reduceAll([...events.slice(0, 4), envelope('exploration/recorded', 5, { report: { ...report, revision: 2 } })])).toThrow()
  })

  it.each(['blocked', 'needs-decision'] as const)('records a %s report when the whole-tree snapshot failed', (status: 'blocked' | 'needs-decision') => {
    const { store, snapshot, work } = fixture()
    const report = captureExploration(store, work, snapshot, undefined, { status, summary: 'The tree could not be listed.', unresolved: ['Need a decision'] }, [], 'Unsupported source file type: unrelated.pipe')
    expect(report.status).toBe(status)
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.sources).toEqual([])
    expect(report.unresolved.join('\n')).toContain('Unsupported source file type: unrelated.pipe')
    expect(report.unresolved.join('\n')).toContain('not acceptance')
  })

  it('accepts a completed report from cited files when the whole-tree snapshot failed elsewhere', () => {
    const { store, snapshot, work, submitted } = fixture()
    const report = captureExploration(store, work, snapshot, undefined, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }], 'Unsupported source file type: unrelated.pipe')
    expect(report.status).toBe('completed')
    expect(report.snapshot).toBe(snapshot.id)
    expect(report.unresolved).toEqual([])
    expect(Buffer.from(store.readArtifact(TASK, report.sources[0]!.excerpt.id)).toString()).toContain('return a - b')
  })

  it.each([
    { label: 'changed', apply: (root: string) => writeFileSync(join(root, 'a.ts'), 'changed\n'), message: 'changed during capture' },
    { label: 'deleted', apply: (root: string) => rmSync(join(root, 'a.ts')), message: 'Exploration source is missing' },
    { label: 'replaced with a symlink', apply: (root: string) => { rmSync(join(root, 'a.ts')); writeFileSync(join(root, 'copy.ts'), 'export function add(a, b) {\n  return a - b\n}\n'); symlinkSync('copy.ts', join(root, 'a.ts')) }, message: 'symlink' },
  ])('rejects a completed report whose cited file was $label even if the tree snapshot already failed', ({ apply, message }: { apply: (root: string) => void; message: string }) => {
    const { root, store, snapshot, work, submitted } = fixture()
    apply(root)
    expect(() => captureExploration(store, work, snapshot, undefined, submitted, [{ path: 'a.ts', startLine: 1, endLine: 2 }], 'Unsupported source file type: unrelated.pipe')).toThrow(message)
    expect(store.artifacts(TASK)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('records a blocked report after an unrelated FIFO makes snapshotWorkspace throw', () => {
    const { root, store, snapshot, work } = fixture()
    execFileSync('mkfifo', [join(root, 'unrelated.pipe')])
    expect(() => snapshotWorkspace(root)).toThrow('Unsupported source file type: unrelated.pipe')
    let failure = ''
    try { snapshotWorkspace(root) } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    const report = captureExploration(store, work, snapshot, undefined, { status: 'blocked', summary: 'Cannot list the tree.', unresolved: ['Need a decision'] }, [], failure)
    expect(report.status).toBe('blocked')
    expect(report.unresolved.join('\n')).toContain('unrelated.pipe')
    expect(report.snapshot).toBe(snapshot.id)
  })
})
