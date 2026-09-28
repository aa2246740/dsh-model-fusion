import { describe, expect, it } from 'vitest'
import { checkCommandUnavailable } from '../src/host/native-checks.js'

describe('acceptance command setup failures', () => {
  it('retains the POSIX command-not-found and not-executable exit codes', () => {
    expect(checkCommandUnavailable(126, '', 'darwin')).toBe(true)
    expect(checkCommandUnavailable(127, '', 'linux')).toBe(true)
  })

  it('recognizes PowerShell concise and classic missing-command diagnostics', () => {
    expect(checkCommandUnavailable(1, "\u001b[31m./missing: The term './missing' is not recognized as a name of a cmdlet, function,\nscript file, or executable program.\u001b[0m", 'win32')).toBe(true)
    expect(checkCommandUnavailable(1, 'FullyQualifiedErrorId : CommandNotFoundException', 'win32')).toBe(true)
    expect(checkCommandUnavailable(1, "The term 'missing' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'win32')).toBe(true)
  })

  it('does not reclassify ordinary failures, missing data files, or unfinished commands', () => {
    expect(checkCommandUnavailable(1, 'AssertionError: expected 5, received -1', 'win32')).toBe(false)
    expect(checkCommandUnavailable(1, 'FileNotFoundError: test-data.json', 'win32')).toBe(false)
    expect(checkCommandUnavailable(1, '', 'win32')).toBe(false)
    expect(checkCommandUnavailable(0, 'CommandNotFoundException', 'win32')).toBe(false)
    expect(checkCommandUnavailable(null, 'CommandNotFoundException', 'win32')).toBe(false)
    expect(checkCommandUnavailable(1, 'CommandNotFoundException', 'linux')).toBe(false)
  })
})
