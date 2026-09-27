import { describe, expect, it } from 'vitest'
import { keepaliveChoice } from '../src/profile/keepalive.js'

describe('cache keepalive choice', () => {
  it('accepts on, off and auto per role; unset stays unset (Lead auto, Worker off at runtime)', () => {
    expect(keepaliveChoice(undefined)).toBeUndefined()
    expect(keepaliveChoice({ lead: 'auto', worker: false })).toEqual({ lead: 'auto', worker: false })
    expect(keepaliveChoice({ lead: true, worker: true })).toEqual({ lead: true, worker: true })
    expect(() => keepaliveChoice({ lead: 'yes', worker: false })).toThrow()
    expect(() => keepaliveChoice({ lead: true })).toThrow()
  })
})
