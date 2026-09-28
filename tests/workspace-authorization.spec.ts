import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathAllowed } from '../src/host/workspace.js'

describe('workspace path authorization', () => {
  it('accepts native separators and compares complete directory segments', () => {
    expect(pathAllowed(join('src', 'nested', 'file.ts'), ['src'])).toBe(true)
    expect(pathAllowed('src-other/file.ts', ['src'])).toBe(false)
    expect(pathAllowed('src', ['src'])).toBe(true)
    expect(pathAllowed('file.ts', ['.'])).toBe(true)
    // A backslash is a filename character on POSIX, not an authorization separator.
    expect(pathAllowed('src\\file.ts', ['src'])).toBe(process.platform === 'win32')
  })

  it('resolves dot segments before checking a frozen allowed directory', () => {
    expect(pathAllowed('src/parts/../file.ts', ['src'])).toBe(true)
    expect(pathAllowed('src/../outside.ts', ['src'])).toBe(false)
    expect(pathAllowed('src/parts/../../outside.ts', ['src'])).toBe(false)
    if (process.platform === 'win32') {
      expect(pathAllowed('src\\..\\outside.ts', ['src'])).toBe(false)
      expect(pathAllowed('src\\parts\\..\\file.ts', ['src'])).toBe(true)
    }
  })

  it('does not authorize paths outside the workspace even with the whole workspace allowed', () => {
    expect(pathAllowed('../outside.ts', ['.'])).toBe(false)
    expect(pathAllowed('/outside.ts', ['.'])).toBe(false)
    expect(pathAllowed('src/../../outside.ts', ['.'])).toBe(false)
    expect(pathAllowed('outside.ts', [''])).toBe(false)
    expect(pathAllowed('outside.ts', ['/'])).toBe(false)
    expect(pathAllowed('src/\0file.ts', ['src'])).toBe(false)
    if (process.platform === 'win32') {
      expect(pathAllowed('C:\\outside.ts', ['.'])).toBe(false)
      expect(pathAllowed('C:outside.ts', ['.'])).toBe(false)
      expect(pathAllowed('\\\\server\\share\\file.ts', ['.'])).toBe(false)
    }
  })
})
