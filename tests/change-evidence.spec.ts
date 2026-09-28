import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { captureChangeBase, saveChangeManifest } from '../src/host/change-evidence.js'
import type { ChangeDiff } from '../src/host/change-evidence.js'
import { snapshotWorkspace } from '../src/host/workspace.js'
import { SnapshotId, TaskId } from '../src/contracts.js'
import { created, TASK } from './helpers.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fusion-change-evidence-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project'); mkdirSync(project)
  const file = join(root, 'state.sqlite'), store = new SqliteFusionStore(file)
  cleanup.push(() => store.close()); store.create(created())
  const read = (id: string) => Buffer.from(store.readArtifact(TASK, id))
  return { root, project, store, file, read, manifest: (id: string) => JSON.parse(read(id).toString()) as { diffs: ChangeDiff[]; changes: string[] } }
}

describe('durable complete change evidence', () => {
  it('replays stored patches into the exact candidate, including empty files, modes, CRLF, links and unusual names', () => {
    const { root, project, store, read, manifest } = fixture()
    // `"` is an illegal Windows filename character; the unusual-name coverage uses a legal variant there.
    const oddName = process.platform === 'win32' ? '文件 [odd] a.txt' : '文件 " a.txt'
    const originals: Record<string, string> = { 'calc.py': 'def add(a, b):\n    return a - b\n', 'crlf.txt': 'first\r\nold\r\nlast\r\n',
      'no-eol.txt': 'one\ntwo', 'remove.txt': 'gone\n', 'empty-remove': '', 'exec.sh': '#!/bin/sh\necho ok\n', [oddName]: 'before\n' }
    for (const [name, text] of Object.entries(originals)) writeFileSync(join(project, name), text)
    symlinkSync('old-target', join(project, 'link'))
    const replay = join(root, 'replay'); cpSync(project, replay, { recursive: true, verbatimSymlinks: true })
    const base = snapshotWorkspace(project), captured = captureChangeBase(store, TASK, base, ['.'])
    writeFileSync(join(project, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(join(project, 'crlf.txt'), 'first\r\nnew\r\nlast\r\n')
    writeFileSync(join(project, 'no-eol.txt'), 'one\ntwo\n')
    writeFileSync(join(project, oddName), 'after\n')
    writeFileSync(join(project, 'new.txt'), 'created without final newline')
    writeFileSync(join(project, 'empty-new'), '')
    chmodSync(join(project, 'exec.sh'), 0o755)
    for (const name of ['remove.txt', 'empty-remove', 'link']) rmSync(join(project, name))
    symlinkSync('new-target', join(project, 'link'))
    const candidate = snapshotWorkspace(project)
    const result = manifest(saveChangeManifest(store, TASK, base, candidate, captured).id)
    // The exec-bit change produces no diff on Windows, which has no mode semantics.
    expect(result.diffs).toHaveLength(process.platform === 'win32' ? 9 : 10)
    const diff = result.diffs.map(item => { expect(item.status).toBe('text'); return read(item.patch!.id).toString() }).join('')
    // Windows git defaults to autocrlf and symlink-as-text; the replay must reproduce bytes and links.
    const gitFlags = ['-c', 'core.autocrlf=false', '-c', 'core.symlinks=true']
    execFileSync('git', [...gitFlags, 'apply', '--check', '-'], { cwd: replay, input: diff, stdio: ['pipe', 'pipe', 'pipe'] })
    execFileSync('git', [...gitFlags, 'apply', '-'], { cwd: replay, input: diff, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(snapshotWorkspace(replay).entries).toEqual(candidate.entries)
    expect(readlinkSync(join(replay, 'link'))).toBe('new-target')
    // Windows has no exec bit; mode assertions only carry meaning on POSIX.
    if (process.platform !== 'win32') expect(lstatSync(join(replay, 'exec.sh')).mode & 0o111).not.toBe(0)
    const calc = result.diffs.find(item => item.path === 'calc.py')!
    expect(read(calc.before!.content!.id).toString()).toBe(originals['calc.py'])
    expect(read(calc.after!.content.id)).toEqual(readFileSync(join(project, 'calc.py')))
  })

  it('persists before bytes across reopen and later edits without using the current file as its base', () => {
    const { project, store, file } = fixture()
    writeFileSync(join(project, 'source'), 'before\n')
    const base = snapshotWorkspace(project), captured = captureChangeBase(store, TASK, base, ['source'])
    store.writeDocument('captured', 0, captured)
    writeFileSync(join(project, 'source'), 'first attempt\n')
    const reopened = new SqliteFusionStore(file); cleanup.push(() => reopened.close())
    const first = saveChangeManifest(reopened, TASK, base, snapshotWorkspace(project), captured)
    writeFileSync(join(project, 'source'), 'reworked attempt\n')
    const second = saveChangeManifest(reopened, TASK, base, snapshotWorkspace(project), captured)
    const changes = [first, second].map(ref => JSON.parse(Buffer.from(reopened.readArtifact(TASK, ref.id)).toString()).diffs[0])
    expect(changes[0].before).toEqual(changes[1].before)
    expect(Buffer.from(reopened.readArtifact(TASK, changes[1].patch.id)).toString()).toContain('-before\n+reworked attempt\n')
    expect(Buffer.from(reopened.readArtifact(TASK, changes[0].after.content.id)).toString()).toBe('first attempt\n')
  })

  it('preserves exact binary and type-change bytes without claiming a textual patch', () => {
    const { project, store, manifest, read } = fixture()
    writeFileSync(join(project, 'binary'), Buffer.from([0, 255, 2]))
    writeFileSync(join(project, 'kind'), 'original\n')
    const base = snapshotWorkspace(project), captured = captureChangeBase(store, TASK, base, ['.'])
    writeFileSync(join(project, 'binary'), Buffer.from([0, 254, 3]))
    // Node resolves a forward-slash absolute target to a drive-rooted path when creating the link on Windows.
    const outsideTarget = process.platform === 'win32' ? 'C:\\outside\\not-read' : '/outside/not-read'
    rmSync(join(project, 'kind')); symlinkSync(outsideTarget, join(project, 'kind'))
    const diffs = manifest(saveChangeManifest(store, TASK, base, snapshotWorkspace(project), captured).id).diffs
    expect(diffs.map(item => item.status)).toEqual(['binary', 'type-change'])
    expect(diffs.every(item => !item.patch)).toBe(true)
    expect(read(diffs[0].before!.content!.id)).toEqual(Buffer.from([0, 255, 2]))
    expect(read(diffs[0].after!.content.id)).toEqual(Buffer.from([0, 254, 3]))
    expect(read(diffs[1].after!.content.id).toString()).toBe(outsideTarget)
  })

  it('captures only allowed files and rejects stale, missing or foreign base evidence', () => {
    const { project, store } = fixture()
    writeFileSync(join(project, 'allowed'), 'before'); writeFileSync(join(project, 'private'), 'excluded')
    const base = snapshotWorkspace(project), captured = captureChangeBase(store, TASK, base, ['allowed'])
    expect(Object.keys(captured.contents)).toEqual(['allowed'])
    writeFileSync(join(project, 'allowed'), 'changed')
    expect(() => captureChangeBase(store, TASK, base, ['allowed'])).toThrow('frozen snapshot')
    const candidate = snapshotWorkspace(project)
    expect(() => saveChangeManifest(store, TASK, base, candidate, { ...captured, snapshot: SnapshotId('wrong') })).toThrow('another base')
    expect(() => saveChangeManifest(store, TASK, base, candidate, { ...captured, contents: {} })).toThrow('missing the base file')
    writeFileSync(join(project, 'allowed'), 'changed again')
    expect(() => saveChangeManifest(store, TASK, base, candidate, captured)).toThrow('frozen snapshot')
    const other = TaskId('other'); store.create(created(other))
    expect(() => saveChangeManifest(store, other, base, snapshotWorkspace(project), captured)).toThrow('not owned')
  })

  it('refuses replacement parent symlinks instead of archiving outside content', () => {
    const { root, project, store } = fixture()
    mkdirSync(join(project, 'src')); writeFileSync(join(project, 'src/file'), 'same')
    const base = snapshotWorkspace(project)
    mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside/file'), 'same')
    rmSync(join(project, 'src'), { recursive: true }); symlinkSync(join(root, 'outside'), join(project, 'src'))
    expect(() => captureChangeBase(store, TASK, base, ['src'])).toThrow('symlink')
    expect(store.artifacts(TASK)).toEqual([])
  })

  it('marks legacy missing before bytes explicitly and still records newly added files', () => {
    const { project, store, manifest, read } = fixture()
    writeFileSync(join(project, 'old'), 'original')
    const base = snapshotWorkspace(project)
    writeFileSync(join(project, 'old'), 'changed'); writeFileSync(join(project, 'new'), 'new\n')
    const result = manifest(saveChangeManifest(store, TASK, base, snapshotWorkspace(project)).id)
    const legacy = result.diffs.find(item => item.path === 'old')!
    expect(legacy.status).toBe('unavailable-base'); expect(legacy.before!.content).toBeUndefined(); expect(legacy.patch).toBeUndefined()
    expect(read(legacy.after!.content.id).toString()).toBe('changed')
    expect(result.diffs.find(item => item.path === 'new')!.patch).toBeDefined()
  })
})
