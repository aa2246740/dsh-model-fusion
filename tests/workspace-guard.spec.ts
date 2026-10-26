import { describe, expect, it } from 'vitest'
import { workspaceWriterDenial } from '../src/host/workspace-guard.js'

const denial = (over: Partial<Parameters<typeof workspaceWriterDenial>[0]> = {}) => workspaceWriterDenial({
  fusionOwned: true, exempt: false, cwd: '/work', leaseHolder: 'fusion-worker', agentId: 'ordinary', ...over,
})

describe('workspace write lease guard', () => {
  it('allows a non-Fusion agent even when a Fusion lease is active in the same directory', () => {
    expect(denial({ fusionOwned: false })).toBeUndefined()
  })

  it('still denies a Fusion agent that does not hold the lease', () => {
    expect(denial()).toBe('Workspace writer is fusion-worker; this Agent is read-only')
  })

  it('allows the Fusion holder, a read or control tool, and a different directory with no lease', () => {
    expect(denial({ agentId: 'fusion-worker' })).toBeUndefined()
    expect(denial({ exempt: true })).toBeUndefined()
    expect(denial({ cwd: '/other', leaseHolder: undefined })).toBeUndefined()
    expect(denial({ cwd: undefined, leaseHolder: 'fusion-worker' })).toBeUndefined()
  })
})
