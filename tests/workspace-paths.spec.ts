import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeRelativePath, pathAllowed, workspacePath, workspaceRelative } from '../src/host/workspace.js'

const win32 = process.platform === 'win32'

describe('workspace-relative allowlist paths', () => {
  it("keeps '.' as the legitimate whole-workspace grant while '', '/' and absolute paths grant nothing", () => {
    expect(pathAllowed('file.ts', ['.'])).toBe(true)
    expect(pathAllowed('src/file.ts', ['.'])).toBe(true)
    expect(pathAllowed('file.ts', [''])).toBe(false)
    expect(pathAllowed('file.ts', ['/'])).toBe(false)
    expect(pathAllowed('file.ts', [])).toBe(false)
  })

  it('matches a grant only by whole segments', () => {
    expect(pathAllowed('src/file.ts', ['src'])).toBe(true)
    expect(pathAllowed('src', ['src'])).toBe(true)
    expect(pathAllowed('src-extra/file.ts', ['src'])).toBe(false)
    expect(pathAllowed('other/file.ts', ['src'])).toBe(false)
  })

  it('resolves dot segments lexically so traversal cannot escape a grant', () => {
    expect(pathAllowed('src/../outside', ['src'])).toBe(false)
    expect(pathAllowed('../outside', ['.'])).toBe(false)
    expect(pathAllowed('src/../src/file.ts', ['src'])).toBe(true)
    expect(pathAllowed('src/./file.ts', ['src'])).toBe(true)
    if (win32) expect(pathAllowed('src\\..\\outside', ['src'])).toBe(false)
  })

  it('rejects absolute, drive-relative, UNC, empty and NUL paths instead of granting them', () => {
    expect(normalizeRelativePath('/outside')).toBeUndefined()
    expect(normalizeRelativePath('')).toBeUndefined()
    expect(normalizeRelativePath('a\0b')).toBeUndefined()
    if (win32) {
      expect(normalizeRelativePath('C:\\outside')).toBeUndefined()
      expect(normalizeRelativePath('C:outside')).toBeUndefined()
      expect(normalizeRelativePath('\\\\server\\share')).toBeUndefined()
      expect(pathAllowed('C:\\outside', ['.'])).toBe(false)
    }
  })

  it('treats backslash as a separator only on Windows', () => {
    if (win32) expect(pathAllowed('src\\file.ts', ['src'])).toBe(true)
    // On POSIX `src\file.ts` is a single legal filename and must not match a `src` grant.
    else expect(pathAllowed('src\\file.ts', ['src'])).toBe(false)
  })
})

describe('model-supplied paths against the canonical workspace root', () => {
  // The lease root is a realpath; the session and its models use whatever spelling the user opened
  // (macOS /tmp/x is /private/tmp/x, and os.tmpdir() itself is under the /var -> /private/var link).
  const base = mkdtempSync(join(tmpdir(), 'fusion-alias-'))
  const root = realpathSync.native(base)
  mkdirSync(join(root, 'project', 'demo'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  const project = join(root, 'project')
  symlinkSync(project, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(root, 'outside'), join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const alias = join(base, 'alias')

  it('maps any spelling of the root to the same workspace-relative path', () => {
    expect(workspaceRelative(project, join(alias, 'calc.py'))).toBe('calc.py')
    expect(workspaceRelative(project, join(alias, 'demo'))).toBe('demo')
    expect(workspaceRelative(project, alias)).toBe('')
    expect(workspaceRelative(project, join(project, 'demo', 'new.py'))).toBe(join('demo', 'new.py'))
    expect(workspaceRelative(project, join('demo', 'new.py'))).toBe(join('demo', 'new.py'))
    expect(workspaceRelative(project, '.')).toBe('')
  })

  it('finds nothing outside the workspace, however the path is spelled', () => {
    expect(workspaceRelative(project, join(alias, '..', 'outside', 'x'))).toBeUndefined()
    expect(workspaceRelative(project, join('..', 'outside'))).toBeUndefined()
    expect(workspaceRelative(project, join(root, 'outside', 'x'))).toBeUndefined()
    expect(workspaceRelative(project, root)).toBeUndefined()
  })

  it('does not follow a link below the root; workspacePath refuses it', () => {
    expect(workspaceRelative(project, join(alias, 'escape', 'x'))).toBe(join('escape', 'x'))
    expect(() => workspacePath(project, join('escape', 'x'))).toThrow(/symlink/)
  })
})
