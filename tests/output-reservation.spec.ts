import { describe, expect, it } from 'vitest'
import { fittedOutputReservation, requestOutputReservation } from '../src/context/guard.js'

describe('fitted output reservation', () => {
  it('uses half of the window after the safety margin', () => {
    expect(fittedOutputReservation(128_000)).toBe(Math.floor((128_000 - 6_400) / 2))
    expect(fittedOutputReservation(10_000)).toBe(Math.floor((10_000 - 2_048) / 2))
  })

  it('keeps a smaller requested reply and clamps one that does not fit', () => {
    expect(requestOutputReservation(128_000, 512)).toBe(512)
    expect(requestOutputReservation(128_000, 200_000)).toBe(fittedOutputReservation(128_000))
    expect(requestOutputReservation(128_000)).toBe(8_000)
  })

  it('does not mistake a million-token context window for an output allowance', () => {
    expect(requestOutputReservation(1_000_000)).toBe(8_000)
    // A cap is honoured when one is passed in; the plugin no longer hardcodes caps for named routes.
    const cap = 131_072
    expect(requestOutputReservation(1_000_000, 475_000, undefined, cap)).toBe(131_072)
    expect(requestOutputReservation(1_000_000, undefined, 16_384, cap)).toBe(16_384)
    expect(requestOutputReservation(1_000_000, undefined, undefined, undefined, 32_000)).toBe(32_000)
  })

  it('rejects a window that cannot hold output', () => {
    expect(() => fittedOutputReservation(2_048)).toThrow(/cannot reserve output/)
    expect(() => fittedOutputReservation(0)).toThrow(/usable context window/)
  })

  it('respects an adapter output cap smaller than its context window', () => {
    expect(requestOutputReservation(1_000_000, undefined, 16_384)).toBe(16_384)
    expect(requestOutputReservation(1_000_000, 512, 16_384)).toBe(512)
    for (const invalid of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => requestOutputReservation(128_000, invalid)).toThrow(/output token limit/)
      expect(() => requestOutputReservation(128_000, undefined, invalid)).toThrow(/output token limit/)
    }
  })
})
