import { describe, expect, it } from 'vitest'
import { fusionToolDiagnostic, projectRoleTools } from '../src/host/tool-table.js'

const tool = (name: string) => ({ name, description: name })

describe('Fusion tool table restoration', () => {
  it('puts Fusion registrations back after another plugin replaces the assembled table', () => {
    const registry = ['bash', 'glob', 'grep', 'read', 'job_output', 'edit', 'write', 'fusion_delegate', 'fusion_explore', 'fusion_wait', 'fusion_submit_result'].map(tool)
    const eager = ['bash', 'glob', 'grep', 'read', 'edit', 'write'].map(tool)
    const allowlist = ['bash', 'glob', 'grep', 'read', 'job_output', 'fusion_delegate', 'fusion_explore', 'fusion_wait']
    const projected = projectRoleTools({ assembled: eager, allowlist, registry })
    expect(projected.missing).toEqual([])
    expect(projected.tools.map(item => item.name)).toEqual(['bash', 'glob', 'grep', 'read', 'job_output', 'fusion_delegate', 'fusion_explore', 'fusion_wait'])
    expect(projected.tools.map(item => item.name)).not.toContain('edit')
    expect(projected.tools.map(item => item.name)).not.toContain('fusion_submit_result')
  })

  it('keeps a writing role\'s table and still unions Fusion tools that were removed', () => {
    const registry = ['bash', 'edit', 'fusion_submit_result', 'fusion_read_state'].map(tool)
    const eager = ['bash', 'edit'].map(tool)
    const projected = projectRoleTools({ assembled: eager, allowlist: undefined, registry, always: ['fusion_submit_result'] })
    expect(projected.missing).toEqual([])
    expect(projected.tools.map(item => item.name)).toEqual(['bash', 'edit', 'fusion_submit_result', 'fusion_read_state'])
  })

  it('names Fusion tools that the allowlist requires and the registry no longer has', () => {
    const projected = projectRoleTools({
      assembled: ['bash', 'read'].map(tool),
      allowlist: ['bash', 'read', 'fusion_delegate', 'fusion_wait'],
      registry: ['bash', 'read'].map(tool),
    })
    expect(projected.tools.map(item => item.name)).toEqual(['bash', 'read'])
    expect(projected.missing).toEqual(['fusion_delegate', 'fusion_wait'])
    expect(fusionToolDiagnostic(projected.missing)).toContain('FUSION_TOOL_TABLE_INCOMPLETE')
    expect(fusionToolDiagnostic(projected.missing)).toContain('do not end the task as completed')
  })

  it('does not require Fusion tools when the role\'s allowlist is empty', () => {
    const projected = projectRoleTools({
      assembled: ['bash', 'fusion_delegate'].map(tool),
      allowlist: [],
      registry: ['bash', 'fusion_delegate'].map(tool),
    })
    expect(projected.tools).toEqual([])
    expect(projected.missing).toEqual([])
  })

  it('restores the Worker report tools when the explore allowlist omits them', () => {
    const registry = ['read', 'glob', 'fusion_submit_result', 'fusion_read_state', 'fusion_read_evidence'].map(tool)
    const projected = projectRoleTools({
      assembled: ['read'].map(tool),
      allowlist: ['read', 'glob', 'grep'],
      registry,
      always: ['fusion_read_state', 'fusion_read_evidence', 'fusion_submit_result'],
    })
    expect(projected.missing).toEqual([])
    expect(projected.tools.map(item => item.name)).toEqual(['read', 'glob', 'fusion_submit_result', 'fusion_read_state', 'fusion_read_evidence'])
  })
})
