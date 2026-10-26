import { describe, expect, it } from 'vitest'
import { hasStartActivation, requireSubagentMethod, supportedDshVersions } from '../src/host/subagent-seam.js'

describe('subagent seam detection', () => {
  it('prefers the 0.2.1 method when both names are present', () => {
    const subagents = { startActivation() {}, startContinuable() {}, start() {}, drainChildren() {}, drainContinuableChildren() {} }
    expect(hasStartActivation(subagents)).toBe(true)
    expect(requireSubagentMethod(subagents, 'startActivation', 'startContinuable')).toBe('startActivation')
    expect(requireSubagentMethod(subagents, 'startActivation', 'start')).toBe('startActivation')
    expect(requireSubagentMethod(subagents, 'drainChildren', 'drainContinuableChildren')).toBe('drainChildren')
  })

  it('keeps the 0.2.0 names when the 0.2.1 names are absent', () => {
    const subagents = { startContinuable() {}, start() {}, drainContinuableChildren() {} }
    expect(hasStartActivation(subagents)).toBe(false)
    expect(requireSubagentMethod(subagents, 'startActivation', 'startContinuable')).toBe('startContinuable')
    expect(requireSubagentMethod(subagents, 'startActivation', 'start')).toBe('start')
    expect(requireSubagentMethod(subagents, 'drainChildren', 'drainContinuableChildren')).toBe('drainContinuableChildren')
  })

  it('names the supported DSH range when neither method exists', () => {
    expect(() => requireSubagentMethod({}, 'startActivation', 'startContinuable')).toThrow(supportedDshVersions)
    expect(() => requireSubagentMethod({}, 'startActivation', 'start')).toThrow(/neither subagents\.startActivation nor subagents\.start/)
    expect(() => requireSubagentMethod({ startContinuable() {} }, 'drainChildren', 'drainContinuableChildren'))
      .toThrow(/neither subagents\.drainChildren nor subagents\.drainContinuableChildren/)
  })
})
