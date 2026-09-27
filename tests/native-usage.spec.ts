import { describe, expect, it } from 'vitest'
import { billFromNativeUsage } from '../src/host/native-usage.js'

describe('native usage boundary', () => {
  it('keeps disjoint input and unknown missing cache and reasoning fields', () => {
    expect(billFromNativeUsage({ inputTokens: 23, outputTokens: 4, cacheReadTokens: 91 })).toEqual({
      uncachedInput: { state: 'known', tokens: 23 }, cacheRead: { state: 'known', tokens: 91 },
      output: { state: 'known', tokens: 4 }, cacheWrite: { kind: 'unknown' },
      reasoning: { kind: 'unknown', tokens: { state: 'unknown' } },
    })
    expect(billFromNativeUsage(undefined).output).toEqual({ state: 'unknown' })
  })
  it('does not infer that reasoning is included in output and rejects invalid counters', () => {
    expect(billFromNativeUsage({ inputTokens: 0, outputTokens: 4, reasoningTokens: 8 }).reasoning)
      .toEqual({ kind: 'unknown', tokens: { state: 'known', tokens: 8 } })
    expect(() => billFromNativeUsage({ inputTokens: -1, outputTokens: 1 })).toThrow()
  })
})
