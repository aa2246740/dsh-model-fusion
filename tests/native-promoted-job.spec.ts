import { describe, expect, it, vi } from 'vitest'
import { NativeEffects } from '../src/host/native-effects.js'
import { TaskId } from '../src/contracts.js'

// Exercise the public tool middleware contract without starting an OS process.
function fixture(shell: 'bash' | 'pwsh', jobKind: string = shell) {
  const taskId = TaskId('promoted-command')
  const agent = { id: 'owned-worker' }
  const documents = new Map<string, { revision: number; value: any }>()
  let dispatch: any
  let settled: any
  const job = { id: `${shell}-1`, kind: jobKind, owner: agent.id, startedAt: Date.now(), status: 'running' }
  const registry = {
    events: { subscribe: (_filter: unknown, callback: any) => { settled = callback; return () => {} } },
    get: vi.fn(() => job),
    kill: vi.fn(),
  }
  const store = {
    putArtifact: () => ({ id: 'arguments' }),
    writeDocument: (id: string, revision: number, value: any) => {
      expect(documents.get(id)?.revision ?? 0).toBe(revision)
      documents.set(id, { revision: revision + 1, value })
    },
    readDocument: (id: string) => documents.get(id),
    listDocumentIds: (prefix: string) => [...documents.keys()].filter(id => id.startsWith(prefix)),
  }
  const ctx = {
    get: () => registry,
    on: (_event: string, callback: any) => { dispatch = callback; return () => {} },
  }
  const failed = vi.fn()
  const effects = new NativeEffects(ctx as never, store as never, {
    owner: () => ({ binding: { taskId } as never, role: 'worker' }),
    track: () => true,
    failed,
    backgroundMaxMs: () => null,
  })
  const dispose = effects.install()
  const execute = (value: unknown) => dispatch({
    token: Symbol('call'), agent, name: shell, callId: 'call-1', rootCallId: 'call-1',
    arguments: { command: 'long-running-command', run_in_background: false },
  }, async () => ({ isError: false, value }))
  return { effects, execute, taskId, failed, dispose, settle: () => {
    job.status = 'completed'
    settled({ type: 'settled', job })
  } }
}

describe.each(['bash', 'pwsh'] as const)('%s foreground timeout promotion', shell => {
  it('retains the pending effect until the authoritative native job settles', async () => {
    const f = fixture(shell)
    try {
      await f.execute({ kind: 'promoted', jobId: `${shell}-1` })
      expect(f.effects.pending(f.taskId)).toHaveLength(1)
      expect(f.effects.onlyBackgroundPending(f.taskId)).toBe(true)
      expect(() => f.effects.assertInspection(f.taskId, true)).toThrow(/still live/)
      f.settle()
      expect(f.effects.pending(f.taskId)).toHaveLength(0)
      expect(f.failed).not.toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('keeps an uncertain effect when the returned job belongs to another tool', async () => {
    const f = fixture(shell, shell === 'bash' ? 'pwsh' : 'bash')
    try {
      await expect(f.execute({ kind: 'promoted', jobId: `${shell}-1` })).rejects.toThrow(/mismatch/)
      expect(f.effects.pending(f.taskId)[0]?.record.state).toBe('outcome-unknown')
      expect(f.failed).toHaveBeenCalled()
    } finally { f.dispose() }
  })

  it('does not mark an unidentifiable promoted process as returned', async () => {
    const f = fixture(shell)
    try {
      await expect(f.execute({ kind: 'promoted' })).rejects.toThrow(/authoritative/)
      expect(f.effects.pending(f.taskId)[0]?.record.state).toBe('outcome-unknown')
    } finally { f.dispose() }
  })
})
