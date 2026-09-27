import { describe, expect, it } from 'vitest'
import { evidencePage } from '../src/host/evidence-page.js'

describe('bounded evidence paging', () => {
  it('recovers all long text without splitting Unicode characters or dropping a BOM', () => {
    const text = '\ufeff' + '中🙂\r\n'.repeat(9000) + 'tail without newline', bytes = Buffer.from(text)
    let offset = 0, restored = '', pages = 0
    do {
      const page = evidencePage(bytes, offset, 101)
      expect(page.encoding).toBe('utf-8'); expect(page.text.length).toBeLessThanOrEqual(101)
      expect(Buffer.from(page.text).toString('utf8')).toBe(page.text)
      restored += page.text; pages++
      if (page.nextOffset === null) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset
    } while (pages < 1000)
    expect(pages).toBeGreaterThan(1); expect(restored).toBe(text)
    expect(evidencePage(Buffer.from('中'.repeat(9000)))).toMatchObject({ truncated: false, nextOffset: null, totalCharacters: 9000, bytes: 27000 })
  })

  it('roundtrips binary as explicit base64 and permits the exact end offset', () => {
    const bytes = Buffer.from([0, 255, 1, 240, 159]), first = evidencePage(bytes, 0, 3)
    const rest = evidencePage(bytes, first.nextOffset!)
    expect(first.encoding).toBe('base64')
    expect(Buffer.from(first.text + rest.text, 'base64')).toEqual(bytes)
    expect(evidencePage(bytes, rest.totalCharacters)).toMatchObject({ text: '', truncated: false, nextOffset: null })
    expect(evidencePage(Buffer.from([255])).encoding).toBe('base64')
  })

  it('rejects invalid ranges and offsets that split an existing surrogate pair', () => {
    const bytes = Buffer.from('a🙂b')
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 99, 2]) expect(() => evidencePage(bytes, offset)).toThrow()
    for (const limit of [0, 1, 1.5, -1, 24001, NaN, Infinity]) expect(() => evidencePage(bytes, 0, limit)).toThrow()
    expect(evidencePage(bytes, 0, 2)).toMatchObject({ text: 'a', nextOffset: 1 })
    expect(evidencePage(bytes, 1, 2)).toMatchObject({ text: '🙂', nextOffset: 3 })
    expect(evidencePage(Buffer.alloc(0))).toMatchObject({ text: '', truncated: false, nextOffset: null })
  })
})
