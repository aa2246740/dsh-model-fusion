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
  it('degrades null-filled gateway counters to unknown instead of INVALID_TOKEN_COUNT', () => {
    // Some claude-opus-5.5 routes report completion_tokens_details as null, so
    // the adapter emits reasoningTokens: null. This must not abort the turn.
    const bill = billFromNativeUsage({
      inputTokens: 4, outputTokens: 1617, cacheWriteTokens: 149462, reasoningTokens: null as unknown as number,
    })
    expect(bill.reasoning).toEqual({ kind: 'unknown', tokens: { state: 'unknown' } })
    expect(bill.uncachedInput).toEqual({ state: 'known', tokens: 4 })
    expect(bill.output).toEqual({ state: 'known', tokens: 1617 })
  })
  it('treats null and non-finite cacheWriteTokens as an unknown cache write', () => {
    expect(billFromNativeUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: null as unknown as number }).cacheWrite)
      .toEqual({ kind: 'unknown' })
    expect(billFromNativeUsage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: Number.NaN }).cacheWrite)
      .toEqual({ kind: 'unknown' })
  })
})
