import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse } from '@fusion-host-test/mock-adapter'
import { toolCallResponse } from '@fusion-host-test/mock-adapter'
import { TestSessionQuery } from '@fusion-host-test/session-query'
import { NativeWorkerTransport } from '../src/host/native-worker.js'
import { mountNativeShell, shellTool, shellCommand } from './shell-fixture.js'
import { observeNativeUsage } from '../src/host/native-usage.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { TaskId, SnapshotId, WorkOrderId } from '../src/contracts.js'
import type { ReviewTicket } from '../src/contracts.js'
import { digestOf } from '../src/digest.js'
import { captureNativeReviewRequest, nativeReviewProof } from '../src/host/native-review.js'
import { created } from '../tests/helpers.js'
import { NativeFusionScopes } from '../src/host/native-scopes.js'
import { completeProfile } from '../src/profile/resolve.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = mkdtempSync(join(tmpdir(), 'fusion-native-worker-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Fork, { providerName: 'fork' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['test-native'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('lead'), meta: { cwd: root }, agentOptions: { provider: 'test-native', model: 'lead' } })
  // Native lifecycle order before the root fiber dispose: drain the durable
  // continuable children this Lead still owns, then dispose the Lead handle.
  cleanups.push(async () => {
    if (ctx.subagents) {
      await ctx.subagents.drainContinuableChildren(handle.agent,
        ctx.agents.list().filter(agent => agent.session.header.parentSession === handle.agent.id).map(agent => agent.id))
      await handle.dispose()
    }
  })
  const parent = handle.agent
  const transport = new NativeWorkerTransport(ctx)
  return { ctx, parent, adapter, transport, root }
}

const request = {
  childId: 'reserved-worker', label: 'Implement a bounded change', brief: 'Implement task A',
  route: { provider: 'test-native', model: 'worker' }, persona: 'You are the execution Worker.', allowedTools: [],
}
const freshSignal = () => new AbortController().signal

async function mountShell(ctx: Context, root: string) {
  // pwsh cold start exceeds the 5s POSIX-comfortable bound under parallel load.
  await mountNativeShell(ctx, { dshHome: join(root, 'dsh-home'), timeoutMs: process.platform === 'win32' ? 15_000 : 5_000 })
}

describe('native persistent Worker transport', () => {
  it('uses an independent child context and preserves that child on rework', async () => {
    const { parent, adapter, transport } = await setup([textResponse('lead answer'), textResponse('worker first'), textResponse('worker revised')])
    parent.send(createUserMessage({ content: [{ type: 'text', text: 'PRIVATE LEAD HISTORY' }] }), 'next-turn', true)
    await parent.whenIdle()
    const first = await transport.start(parent, request, freshSignal())
    const child = await transport.settle(parent, first.childId, freshSignal())
    expect(first.childId).toBe(request.childId)
    expect(child.session.header.parentSession).toBe(parent.id)
    expect(adapter.requests[1].model).toBe('worker')
    expect(JSON.stringify(adapter.requests[1].messages)).not.toContain('PRIVATE LEAD HISTORY')
    const second = await transport.continue(parent, first.childId, 'Fix the missing edge case', freshSignal())
    expect(second.childId).toBe(first.childId)
    expect(second.messageId).not.toBe(first.messageId)
    expect(await transport.settle(parent, second.childId, freshSignal())).toBe(child)
    expect(JSON.stringify(adapter.requests[2].messages)).toContain('worker first')
    expect(JSON.stringify(adapter.requests[2].messages)).toContain('Fix the missing edge case')
  })

  it('waits for native cancellation to converge before returning a quiescent child', async () => {
    const { parent, transport, adapter } = await setup(['hang-slow'])
    await transport.start(parent, request, freshSignal())
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    const abort = new AbortController()
    let settled = false
    const draining = transport.settle(parent, request.childId, abort.signal).then(child => { settled = true; return child })
    abort.abort(new Error('user cancelled'))
    expect(settled).toBe(false)
    const child = await draining
    expect(child.status).toBe('idle')
    const end = child.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
    expect(end?.data.reason.kind).toBe('aborted')
    expect(child.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.interrupted)).toBe(true)
  })

  it('replaces an active generation with a new brief on the same durable child and counts the aborted call', async () => {
    const { ctx, parent, transport, adapter } = await setup(['hang-slow', textResponse('revised from both briefs')])
    const store = new SqliteFusionStore(':memory:')
    cleanups.push(async () => { store.close() })
    const remove = observeNativeUsage(ctx, store, agent => agent.id === request.childId ? { taskId: TaskId('steering-usage'), role: 'worker' } : undefined)
    cleanups.push(async () => { remove() })
    const initial = await transport.start(parent, request, freshSignal())
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    const child = ctx.agents.get(SessionId(initial.childId))!
    const revised = await transport.interruptAndContinue(parent, child.id, 'REVISION: reject duplicate identifiers', freshSignal())
    expect(revised.childId).toBe(initial.childId)
    expect(revised.messageId).not.toBe(initial.messageId)
    expect(await transport.settle(parent, child.id, freshSignal())).toBe(child)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1].messages)).toContain(request.brief)
    expect(JSON.stringify(adapter.requests[1].messages)).toContain('REVISION: reject duplicate identifiers')
    expect(child.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted', 'completed'])
    const usages = store.listDocumentIds('usage:steering-usage:').map(id => store.readDocument(id)!.value)
    expect(usages).toHaveLength(2)
    expect(usages).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'aborted', upstreamHttpCalls: null, actualSubscriptionChargeUsd: null }),
      expect.objectContaining({ outcome: 'stop' }),
    ]))
  })

  it('rejects a fork provider, duplicate creation and unowned child interruption', async () => {
    const { ctx, parent, transport } = await setup([textResponse('done')])
    expect(() => new NativeWorkerTransport(ctx, 'fork').assertAvailable()).toThrow('independent')
    await transport.start(parent, request, freshSignal())
    await transport.settle(parent, request.childId, freshSignal())
    await expect(transport.start(parent, request, freshSignal())).rejects.toThrow('already exists')
    await expect(transport.stop(parent, 'unknown')).rejects.toThrow('absent')
    await expect(transport.stop(parent, parent.id)).rejects.toThrow('not this Lead')
  })

  it('records actual native stream observations without inventing missing billing fields', async () => {
    const { ctx, parent, transport } = await setup([textResponse('completed')])
    const store = new SqliteFusionStore(':memory:')
    cleanups.push(async () => { store.close() })
    const remove = observeNativeUsage(ctx, store, agent => agent.id === request.childId ? { taskId: TaskId('task-usage'), role: 'worker' } : undefined)
    cleanups.push(async () => { remove() })
    await transport.start(parent, request, freshSignal())
    await transport.settle(parent, request.childId, freshSignal())
    const ids = store.listDocumentIds('usage:task-usage:')
    expect(ids).toHaveLength(1)
    expect(store.readDocument(ids[0])?.value).toMatchObject({
      sessionId: request.childId, role: 'worker', outcome: 'stop', nativeStreamInvocations: 1,
      upstreamHttpCalls: null, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null,
      ledger: { observations: [
        { mode: 'snapshot', bill: { cacheRead: { state: 'unknown' }, reasoning: { kind: 'unknown' } } },
        { mode: 'final', bill: { uncachedInput: { state: 'known', tokens: 10 } } },
      ] },
    })
  })

  it('continues the same persisted child after the owning Host context closes', async () => {
    const { ctx, parent, transport, root } = await setup([textResponse('persistent first answer')])
    await transport.start(parent, request, freshSignal())
    await transport.settle(parent, request.childId, freshSignal())
    await ctx.sessions.flush(parent.session)
    await ctx.fiber.dispose()
    const fresh = new Context()
    cleanups.push(async () => {
      if (fresh.subagents && freshHandle) {
        await fresh.subagents.drainContinuableChildren(freshHandle.agent,
          fresh.agents.list().filter(agent => agent.session.header.parentSession === freshHandle.agent.id).map(agent => agent.id))
        await freshHandle.dispose()
      }
      await fresh.fiber.dispose()
    })
    let freshHandle: Awaited<ReturnType<typeof fresh.agents.resume>> | undefined
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(TestSessionQuery)
    await fresh.plugin(SubagentRuntime)
    await fresh.plugin(Spawn, { providerName: 'spawn' })
    const adapter = new MockAdapter([textResponse('persistent second answer')])
    fresh.llm.registerAdapter(['test-native'], adapter)
    const handle = await fresh.agents.resume({ resumeSessionId: parent.id, agentOptions: { provider: 'test-native', model: 'lead' } })
    freshHandle = handle
    const recovered = new NativeWorkerTransport(fresh)
    expect(fresh.agents.get(SessionId(request.childId))).toBeUndefined()
    const accepted = await recovered.continue(handle.agent, request.childId, 'Continue after restart', freshSignal())
    const child = await recovered.settle(handle.agent, accepted.childId, freshSignal())
    expect(child.id).toBe(request.childId)
    expect(JSON.stringify(adapter.requests[0].messages)).toContain('persistent first answer')
    expect(JSON.stringify(adapter.requests[0].messages)).toContain('Continue after restart')
  })

  it('runs and reworks a real native shell tool, including native permission denial', async () => {
    const { ctx, parent, transport, root, adapter } = await setup([
      toolCallResponse('write-first', shellTool, { command: shellCommand('printf first > result.txt', "[IO.File]::WriteAllText((Join-Path $PWD 'result.txt'),'first')"), description: 'Write the test-owned result file' }),
      textResponse('first done'),
      toolCallResponse('write-rework', shellTool, { command: shellCommand('printf revised > result.txt', "[IO.File]::WriteAllText((Join-Path $PWD 'result.txt'),'revised')"), description: 'Revise the test-owned result file' }),
      textResponse('revised done'),
      toolCallResponse('denied-call', shellTool, { command: shellCommand('printf forbidden > blocked-file.txt', "[IO.File]::WriteAllText((Join-Path $PWD 'blocked-file.txt'),'forbidden')"), description: 'Exercise the test denial policy' }),
      textResponse('policy denied'),
    ])
    await mountShell(ctx, root)
    ctx.on('tools/pre-execute', (exec, next) => JSON.stringify(exec.arguments).includes('blocked-file.txt')
      ? Promise.resolve({ kind: 'deny', reason: 'test policy denies this file' }) : next())
    await transport.start(parent, { ...request, allowedTools: [shellTool] }, freshSignal())
    const child = await transport.settle(parent, request.childId, freshSignal())
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('first')
    await transport.continue(parent, child.id, 'Revise the result', freshSignal())
    await transport.settle(parent, child.id, freshSignal())
    expect(readFileSync(join(root, 'result.txt'), 'utf8')).toBe('revised')
    await transport.continue(parent, child.id, 'Exercise denial', freshSignal())
    await transport.settle(parent, child.id, freshSignal())
    expect(existsSync(join(root, 'blocked-file.txt'))).toBe(false)
    expect(child.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(3)
    expect(adapter.requests).toHaveLength(6)
  })

  it('keeps Fusion routing and tools scoped, and restores the native route on detach', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('fusion'), textResponse('ordinary'), textResponse('native again')])
    // The real session controller owns this selection; the test composes the same public seam.
    installModelSelection(parent.ctx, { current: { provider: 'test-native', model: 'lead' }, assembled: undefined })
    const prompts = { lead: 'FUSION LEAD ONLY', worker: 'WORKER ONLY', compact: 'Checkpoint' }
    const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
      lead: { provider: 'test-native', model: 'fusion-lead' }, worker: request.route }, prompts)
    let frozenCalls = 0
    const scopes = new NativeFusionScopes({
      canRequest: () => undefined, canExecute: () => undefined,
      beforeRequest: () => { frozenCalls++ },
      installTools: scope => [scope.tools.register(defineTool({
        name: 'fusion_probe', description: 'Scoped test capability', parameters: {},
        output: { schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } }, additionalProperties: false },
          render: () => [{ type: 'text', text: 'ok' }] }, execute: async () => ({ ok: true }),
      }))],
    })
    scopes.install(parent, { schemaVersion: 1, sessionId: parent.id, taskId: TaskId('scoped'), selected: true, profile, prompts }, 'lead')
    const ordinary = (await ctx.agents.create({ sessionId: SessionId('ordinary'), agentOptions: { provider: 'test-native', model: 'ordinary-model' } })).agent
    expect(ctx.tools.get('fusion_probe', parent)).toBeDefined()
    expect(ctx.tools.get('fusion_probe', ordinary)).toBeUndefined()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }] }))
    await parent.whenIdle()
    ordinary.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }] }))
    await ordinary.whenIdle()
    expect(adapter.requests[0].model).toBe('fusion-lead')
    expect(JSON.stringify(adapter.requests[0].messages)).toContain('FUSION LEAD ONLY')
    expect(adapter.requests[1].model).toBe('ordinary-model')
    expect(JSON.stringify(adapter.requests[1].messages)).not.toContain('FUSION LEAD ONLY')
    scopes.detach(parent)
    expect(ctx.tools.get('fusion_probe', parent)).toBeUndefined()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'third' }] }))
    await parent.whenIdle()
    expect(adapter.requests[2].model).toBe('lead')
    expect(frozenCalls).toBe(1)
  })

  it.each(['tool-calls', 'max-tokens'] as const)('binds review to the captured request and checks native finish %s', async finish => {
    const chunks = toolCallResponse('lead-review-call', 'fusion_review_result', { decision: 'accept' })
      .map(chunk => chunk.type === 'finish' ? { type: 'finish' as const, reason: { kind: finish } } : chunk)
    const { parent } = await setup([chunks, textResponse('review acknowledged')])
    const store = new SqliteFusionStore(':memory:')
    cleanups.push(async () => { store.close() })
    const taskId = TaskId('native-review')
    store.create(created(taskId))
    const first: ReviewTicket = {
      id: 'ticket-before-dispatch', requestId: 'request-before-dispatch', generation: 1,
      subject: { taskId, workOrderId: WorkOrderId('wo-native'), revision: 1, reportId: 'report-1',
        reportDigest: digestOf('report-1'), snapshot: SnapshotId('snapshot-1') },
      validationDigest: digestOf('validation'), workOrderDigest: digestOf('frozen-order'),
    }
    let latest = first
    parent.ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      captureNativeReviewRequest(store, parent, payload.turn, payload.step, latest)
      return config
    })
    parent.ctx.tools.register(defineTool({
      name: 'fusion_review_result', description: 'Record this review result',
      parameters: { decision: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.requestId }] },
      execute: async (_args, exec) => {
        latest = { ...first, id: 'new-ticket', requestId: 'new-request', generation: 2 }
        const proof = nativeReviewProof(store, taskId, exec)
        return { requestId: proof.ticket.requestId }
      },
    }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the submitted report' }] }))
    await parent.whenIdle()
    const result = parent.session.snapshotEvents().find(event => event.type === 'tool/result')
    if (finish === 'max-tokens') {
      // The native loop already refuses to dispatch truncated tool calls.
      expect(result).toBeUndefined()
      expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('max-tokens')
      expect(store.artifacts(taskId)).toHaveLength(0)
      return
    }
    expect(result?.type).toBe('tool/result')
    if (!result || result.type !== 'tool/result') throw new Error('native review tool did not execute')
    expect(Boolean(result.data.message.content[0].isError)).toBe(false)
    expect(JSON.stringify(result.data)).toContain('request-before-dispatch')
    expect(store.artifacts(taskId)).toHaveLength(1)
  })
})
