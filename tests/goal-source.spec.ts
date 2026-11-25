import { describe, expect, it } from 'vitest'
import { isInstructionSource } from '../src/message-source.js'

describe('instruction source classification (Issue #23 Goal mode)', () => {
  it('accepts direct human messages, legacy unspecified user-role messages, and positive goal rounds', () => {
    expect(isInstructionSource(undefined)).toBe(true)
    expect(isInstructionSource({ kind: 'user' })).toBe(true)
    expect(isInstructionSource({ kind: 'goal', round: 1 })).toBe(true)
    expect(isInstructionSource({ kind: 'goal', round: 12 })).toBe(true)
    expect(isInstructionSource({ kind: 'goal' })).toBe(true)
  })

  it('rejects round-0 goal context injections and non-instruction plugin/system sources', () => {
    expect(isInstructionSource({ kind: 'goal', round: 0 })).toBe(false)
    expect(isInstructionSource({ kind: 'goal', round: -1 })).toBe(false)
    expect(isInstructionSource({ kind: 'plugin:dsh-model-fusion' })).toBe(false)
    expect(isInstructionSource({ kind: 'model-selection' })).toBe(false)
    expect(isInstructionSource({ kind: 'tool-goal' })).toBe(false)
    expect(isInstructionSource({ kind: 'system-prompt' })).toBe(false)
  })
})
