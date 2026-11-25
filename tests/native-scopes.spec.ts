import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TaskId } from '../src/contracts.js'
import { NativeFusionScopes } from '../src/host/native-scopes.js'
import { completeProfile } from '../src/profile/resolve.js'

const prompts = { lead: 'Lead', worker: 'Worker', compact: 'Checkpoint' }
const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
  lead: { provider: 'configured', model: 'lead' }, worker: { provider: 'configured', model: 'worker' } }, prompts)

function agent(): Agent {
  const dispose = () => {}
  return {
    id: 'lead-1',
    status: 'idle',
    ctx: {
      tools: { guard: () => dispose, restrict: () => dispose },
      on: () => dispose,
      systemPrompt: { section: () => dispose },
    },
  } as unknown as Agent
}

describe('NativeFusionScopes.install tool order', () => {
  it('runs installTools before refreshTools', () => {
    const order: string[] = []
    const scopes = new NativeFusionScopes({
      canRequest: () => undefined,
      canExecute: () => undefined,
      beforeRequest: () => {},
      installTools: () => {
        order.push('installTools')
        return [() => {}]
      },
      readOnlyTools: () => {
        order.push('refreshTools')
        return ['fusion_delegate', 'fusion_explore']
      },
    })
    scopes.install(agent(), {
      schemaVersion: 1, sessionId: 'lead-1', taskId: TaskId('task-1'), selected: true, profile, prompts,
    }, 'lead')
    expect(order).toEqual(['installTools', 'refreshTools'])
  })
})
