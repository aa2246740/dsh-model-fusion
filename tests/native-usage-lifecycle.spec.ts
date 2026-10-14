import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { observeNativeUsage, type NativeUsageRecord } from '../src/host/native-usage.js'
import { TaskId } from '../src/contracts.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
function setup() {
  const ctx = new Context(), store = new SqliteFusionStore(':memory:'), agent = { id: 'worker' } as Agent
  const registry = new AgentRegistry(ctx)
  vi.spyOn(registry, 'currentInitiator').mockReturnValue(agent)
  vi.spyOn(registry, 'get').mockReturnValue(agent)
  const dispose = observeNativeUsage(ctx, store, () => ({ taskId: TaskId('t'), role: 'worker' }))
  cleanup.push(async () => { dispose(); await ctx.fiber.dispose(); store.close() })
  const stream = (next: () => AsyncIterable<StreamChunk>, signal?: AbortSignal) => ctx.waterfall('llm/stream', {
    provider: 'fixture', model: 'worker', sessionId: agent.id, purpose: 'compaction', maxTokens: 65536, messages: [], signal,
  } as GenerateOptions, next)
  const rows = () => store.listDocumentIds('usage:').map(id => store.readDocument(id)!.value as NativeUsageRecord)
  return { store, stream, rows }
}

describe('bounded compaction observer lifecycle', () => {
  it.each(['empty', 'throw', 'break'] as const)('settles %s streams without requiring a finish chunk', async mode => {
    const { stream, rows } = setup()
    const consume = async () => { for await (const _ of stream(async function* () {
      if (mode === 'throw') throw new Error('fixture')
      if (mode === 'break') { yield { type: 'text-delta', index: 0, text: 'synthetic' }; throw new Error('must not resume') }
    })) break }
    if (mode === 'throw') await expect(consume()).rejects.toThrow('fixture'); else await consume()
    expect(rows()).toHaveLength(1); expect(rows()[0]).toMatchObject({ outcome: 'unknown', endedAt: expect.any(String) })
  })

  it('does not mistake abort for completion while an upstream await ignores the signal', async () => {
    const { stream, rows } = setup(), controller = new AbortController()
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    const iterator = stream(async function* () { await gate }, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next(); controller.abort(); await Promise.resolve()
    expect(rows()[0]).toMatchObject({ outcome: 'entered', endedAt: null })
    release(); await pending
    expect(rows()[0]).toMatchObject({ outcome: 'aborted', endedAt: expect.any(String) })
  })

  it('keeps deliberately suspended consumers distinguishable from settled streams', async () => {
    const { stream, rows, store } = setup()
    const held = []
    for (let i = 0; i < 32; i++) {
      const iterator = stream(async function* () { yield { type: 'text-delta', index: 0, text: 'synthetic' } })[Symbol.asyncIterator]()
      await iterator.next(); held.push(iterator)
    }
    expect(rows().filter(row => row.endedAt === null)).toHaveLength(32)
    expect(store.statusSnapshot(index => index.read('t')).usage.compactionCalls).toBe(32)
    for (const iterator of held) await iterator.return?.()
    expect(rows().filter(row => row.endedAt === null)).toHaveLength(0)
    expect(store.statusSnapshot(index => index.read('t')).usage.calls).toBe(32)
  })

  it('propagates final persistence failure without fabricating a completed durable record', async () => {
    const { stream, rows, store } = setup(), write = store.writeDocuments.bind(store)
    vi.spyOn(store, 'writeDocuments').mockImplementationOnce(write).mockImplementation(() => { throw new Error('synthetic disk failure') })
    await expect((async () => { for await (const _ of stream(async function* () {})) {} })()).rejects.toThrow('synthetic disk failure')
    expect(rows()).toHaveLength(1); expect(rows()[0]).toMatchObject({ outcome: 'entered', endedAt: null })
    expect(store.statusSnapshot(index => index.read('t')).requests[0].outcome).toBe('entered')
  })
})
