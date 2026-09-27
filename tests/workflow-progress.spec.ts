import { describe, expect, it } from 'vitest'
import { advanceProgress, type ProgressWindow } from '../src/host/native-workflow.js'
import { completeProfile } from '../src/profile/resolve.js'
import { modelProfileFromChoice } from '../src/host/settings.js'

describe('enforced workflow progress', () => {
  it('recognizes alternating repetitions without treating unrelated successes as amnesty', () => {
    let window: ProgressWindow | undefined
    const stalled = ['a', 'b', 'a', undefined, 'b', 'a'].map(fingerprint => {
      const next = advanceProgress(window, { milestone: 'one', fingerprint, role: 'lead' })
      window = next.window
      return next.stalled
    })
    expect(stalled).toEqual([false, false, false, false, false, true])
    expect(advanceProgress(window, { milestone: 'two', fingerprint: 'a', role: 'lead' }).stalled).toBe(false)
  })

  it('allows substantial distinct reading beyond the old arbitrary read limit', () => {
    let window: ProgressWindow | undefined
    for (let i = 0; i < 100; i++) {
      const next = advanceProgress(window, { milestone: 'one', fingerprint: `file-${i}`, role: 'lead' })
      expect(next.stalled).toBe(false)
      expect(next.window.recent.length).toBeLessThanOrEqual(8)
      window = next.window
    }
  })

  it('detects tiny successive reads even when their arguments differ', () => {
    let window: ProgressWindow | undefined
    for (let i = 0; i < 12; i++) {
      const next = advanceProgress(window, { milestone: 'one', fingerprint: `offset-${i}`, tinyPath: 'large.py', role: 'lead' })
      expect(next.stalled).toBe(i === 11)
      window = next.window
    }
  })
})

describe('frozen workflow selection', () => {
  const prompts = { lead: 'Lead', worker: 'Worker', compact: 'Compact' }
  const pair = { lead: { provider: 'fixture', model: 'lead' }, worker: { provider: 'fixture', model: 'worker' } }
  it('enforces new product selections and roundtrips old profiles without silently migrating their digest', () => {
    const profile = completeProfile(modelProfileFromChoice(pair), prompts)
    expect(profile.workflowPolicy).toBe('enforced-v3')
    const v2 = completeProfile({ ...modelProfileFromChoice(pair), workflowPolicy: 'enforced-v2' }, prompts)
    expect(completeProfile(v2 as unknown as Record<string, unknown>, prompts)).toEqual(v2)
    expect(completeProfile(profile as unknown as Record<string, unknown>, prompts)).toEqual(profile)
    const legacy = completeProfile({ ...modelProfileFromChoice(pair), workflowPolicy: undefined }, prompts)
    expect(legacy).not.toHaveProperty('workflowPolicy')
    expect(completeProfile(legacy as unknown as Record<string, unknown>, prompts)).toEqual(legacy)
    const v1 = completeProfile({ ...modelProfileFromChoice(pair), workflowPolicy: 'enforced-v1' }, prompts)
    expect(completeProfile(v1 as unknown as Record<string, unknown>, prompts)).toEqual(v1)
    expect(() => completeProfile({ ...pair, workflowPolicy: 'enforced-v1' }, prompts)).toThrow('workflow policy')
  })
})
