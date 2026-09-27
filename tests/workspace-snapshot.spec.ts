import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedPaths, snapshotWorkspace } from '../src/host/workspace.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function project(git: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'fusion-snapshot-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'app.py'), 'print(1)\n')
  mkdirSync(join(root, '.venv/lib'), { recursive: true })
  writeFileSync(join(root, '.venv/lib/big.so'), 'x')
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.git/info/exclude'), '.venv/\nbuild/\n')
  }
  return root
}

describe('workspace snapshot scope (large real projects, study 2026-09-25)', () => {
  it('uses the repository ignore rules, so a virtualenv or build output never counts as source', () => {
    const root = project(true)
    mkdirSync(join(root, 'build')); writeFileSync(join(root, 'build/out.bin'), 'y')
    writeFileSync(join(root, 'untracked.py'), 'print(2)\n')
    const snap = snapshotWorkspace(root)
    expect(snap.ignoreRules).toBe('git-exclude-standard')
    expect(snap.entries.map(entry => entry.path)).toEqual(['app.py', 'untracked.py'])
    // A Worker edit to source is still a change; an edit inside the ignored virtualenv is not.
    writeFileSync(join(root, 'app.py'), 'print(3)\n'); writeFileSync(join(root, '.venv/lib/big.so'), 'z')
    expect(changedPaths(snap, snapshotWorkspace(root))).toEqual(['app.py'])
  })

  it('falls back to known environment directories outside git', () => {
    const snap = snapshotWorkspace(project(false))
    expect(snap.ignoreRules).toBeUndefined()
    expect(snap.entries.map(entry => entry.path)).toEqual(['app.py'])
  })

  it('fingerprints a very large file by metadata instead of refusing the workspace', () => {
    const root = project(true)
    writeFileSync(join(root, 'data.bin'), ''); truncateSync(join(root, 'data.bin'), 200 * 1024 * 1024)
    const snap = snapshotWorkspace(root)
    expect(snap.entries.map(entry => entry.path)).toEqual(['app.py', 'data.bin'])
  })
})
