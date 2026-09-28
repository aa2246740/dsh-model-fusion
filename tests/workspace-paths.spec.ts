import { describe, expect, it } from 'vitest'
import { normalizeRelativePath, pathAllowed } from '../src/host/workspace.js'

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
