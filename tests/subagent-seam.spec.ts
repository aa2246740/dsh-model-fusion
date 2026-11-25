import { describe, expect, it } from 'vitest'
import { hasStartActivation, requireSubagentMethod, supportedDshVersions } from '../src/host/subagent-seam.js'

describe('subagent seam detection', () => {
  it('recognizes the 0.2.2-rc.5 startActivation method', () => {
    const subagents = { startActivation() {} }
    expect(hasStartActivation(subagents)).toBe(true)
    expect(requireSubagentMethod(subagents, 'startActivation')).toBe('startActivation')
  })

  it('names the supported DSH version when startActivation is absent', () => {
    expect(hasStartActivation({})).toBe(false)
    expect(() => requireSubagentMethod({}, 'startActivation')).toThrow(supportedDshVersions)
    expect(() => requireSubagentMethod({}, 'startActivation')).toThrow(/does not provide subagents\.startActivation/)
  })
})
