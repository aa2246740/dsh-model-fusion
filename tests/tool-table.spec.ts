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

  it('does not require allowlisted Fusion tools this agent never registered', () => {
    const projected = projectRoleTools({
      assembled: ['bash', 'read', 'write', 'edit'].map(tool),
      allowlist: ['bash', 'read', 'fusion_delegate', 'fusion_read_state', 'fusion_delegate_text', 'fusion_takeover', 'fusion_submit_result'],
      registry: ['bash', 'read', 'write', 'edit', 'fusion_delegate'].map(tool),
    })
    expect(projected.missing).toEqual([])
    expect(projected.tools.map(item => item.name)).toEqual(['bash', 'read', 'fusion_delegate'])
    for (const name of ['write', 'edit', 'fusion_read_state', 'fusion_delegate_text', 'fusion_takeover', 'fusion_submit_result']) {
      expect(projected.tools.map(item => item.name)).not.toContain(name)
    }
  })

  it('keeps the incomplete-table wording for a gap a caller still reports', () => {
    const message = fusionToolDiagnostic(['fusion_delegate'])
    expect(message).toContain('FUSION_TOOL_TABLE_INCOMPLETE')
    expect(message).toContain('fusion_delegate')
    expect(message).toContain('do not end the task as completed')
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

  it('does not require Worker always-tools this agent never registered', () => {
    const projected = projectRoleTools({
      assembled: ['read', 'write'].map(tool),
      allowlist: ['read', 'glob', 'grep', 'fusion_read_state'],
      registry: ['read', 'glob', 'write', 'fusion_read_evidence', 'fusion_submit_result'].map(tool),
      always: ['fusion_read_state', 'fusion_read_evidence', 'fusion_submit_result'],
    })
    expect(projected.missing).toEqual([])
    expect(projected.tools.map(item => item.name)).toEqual(['read', 'glob', 'fusion_read_evidence', 'fusion_submit_result'])
    expect(projected.tools.map(item => item.name)).not.toContain('fusion_read_state')
    expect(projected.tools.map(item => item.name)).not.toContain('write')
  })
})
