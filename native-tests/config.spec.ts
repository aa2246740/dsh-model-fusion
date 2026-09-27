import { describe, expect, it } from 'vitest'
import { Config } from '../src/dsh-model-fusion.js'

describe('actual plugin configuration normalization', () => {
  it('retains the default native Worker tools when the loader normalizes empty configuration', () => {
    expect(Config({}).workerTools).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_kill'])
  })
  it.each([{ tools: [] }, { tools: ['read'] }])('preserves an explicit tool restriction: $tools', ({ tools }) => {
    expect(Config({ workerTools: tools }).workerTools).toEqual(tools)
  })
})
