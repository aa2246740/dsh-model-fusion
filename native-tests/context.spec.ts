import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { MockAdapter, textResponse, toolCallResponse } from '@fusion-host-test/mock-adapter'
import { NativeContextGuard } from '../src/host/native-context.js'
import { NativeRequestBudget, authorizeConfiguredPair } from '../src/host/native-budget.js'
import { observeNativeUsage } from '../src/host/native-usage.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { completeProfile } from '../src/profile/resolve.js'
import { profileRoutes } from '../src/profile/compactor.js'
import type { PairProfile, Role } from '../src/contracts.js'
import type { SessionBinding } from '../src/host/bindings.js'
import { NativeTaskContext, FUSION_TASK_CONTEXT } from '../src/host/native-task-context.js'
import { SessionId as FusionSessionId } from '../src/contracts.js'
import { assertWorkerBriefRequest } from '../src/host/native-worker-brief.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], options: { capacity?: number | null; compaction?: boolean; target?: number; isolated?: boolean; canonical?: boolean;
  compactor?: PairProfile['compactor']; compactorCapacity?: number; authorizeCompactor?: boolean; role?: Role; modelWindowTarget?: boolean; extraSystem?: string } = {}) {
  const role = options.role ?? 'lead'
  const dir = mkdtempSync(join(tmpdir(), 'fusion-context-')), ctx = new Context(), store = new SqliteFusionStore(join(dir, 'state.sqlite'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.isolated) {
    const presets = join(dir, 'presets'), preset = join(presets, 'isolated')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), '- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n  config:\n    - id: native-compaction\n      name: cordis:fixture-compaction\n      config:\n        auto: false\n        maxTokens: 512\n')
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    ctx.loader.builtins['fixture-compaction'] = BasicCompaction
    await ctx.plugin(AgentPresets, { default: 'isolated' })
    await ctx.agentPresets.register({ id: 'isolated', plugins: parseYaml(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')) })
  } else if (options.compaction !== false) await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
  class ContextAdapter extends MockAdapter {
    override async resolveModel(provider: string, model: string) {
      return { ...await super.resolveModel(provider, model),
        ...(provider === 'summary-fixture' ? { context: { contextWindow: options.compactorCapacity ?? 16_000 },
          reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
          : options.capacity === null ? {} : { context: { contextWindow: options.capacity ?? 32_000 } }) }
    }
  }
  const adapter = new ContextAdapter(script)
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.llm.registerAdapter(['summary-fixture'], adapter)
  const agent = (await ctx.agents.create({ sessionId: SessionId('context'), agentOptions: { provider: 'fixture', model: role, maxTokens: 512 },
    ...(options.isolated ? { setup: async (scope: Context) => { await ctx.agentPresets.mount(scope, 'isolated') } } : {}) })).agent
  if (options.extraSystem) agent.ctx.systemPrompt.section({ name: 'large-standard-preset-fixture', order: 50, text: options.extraSystem })
  const prompts = { lead: 'Lead', worker: 'Worker', compact: 'Compact' }
  const profile = completeProfile({ id: 'test', version: '1', enabled: true, lead: { provider: 'fixture', model: 'lead' },
    worker: { provider: 'fixture', model: 'worker' }, ...(options.compactor ? { compactor: options.compactor } : {}),
    context: { [role]: { ...(options.modelWindowTarget ? {} : { targetInputTokens: options.target ?? 1800 }),
      reserveOutputTokens: 512, minSafetyTokens: 64, safetyFraction: 0.01 } } }, prompts)
  const binding = { schemaVersion: 1, selected: true, sessionId: agent.id, taskId: 'context-task', profile, prompts } as SessionBinding
  const owner = (candidate: typeof agent) => candidate === agent ? { binding, role } : undefined
  const blocked: string[] = []
  const budget = new NativeRequestBudget(store)
  const authorization = authorizeConfiguredPair(store, options.authorizeCompactor === false ? [profile.lead] : profileRoutes(profile), { acknowledgeAccountUsage: true, acknowledgeUnknownCost: true,
    validHours: 1, maxNativeRequests: 10, maxReservedOutputTokens: 20_000 })
  const disposeUsage = observeNativeUsage(ctx, store, candidate => candidate === agent ? { taskId: binding.taskId, role } : undefined)
  const canonical = options.canonical ? new NativeTaskContext(store, id => id === agent.id ? agent : undefined) : undefined
  if (canonical) {
    store.create({ schemaVersion: 1, id: 'task-created', taskId: binding.taskId, seq: 1, revision: 1,
      type: 'task/created', createdAt: new Date().toISOString(), causeId: 'fixture',
      payload: { parent: FusionSessionId(agent.id), selection: { kind: 'profile', profileId: profile.id } } })
    store.append(binding.taskId, 1, [{ schemaVersion: 1, id: 'profile-frozen', taskId: binding.taskId, seq: 2, revision: 1,
      type: 'profile/frozen', createdAt: new Date().toISOString(), causeId: 'fixture',
      payload: { profileId: profile.id, version: profile.version, digest: profile.digest } }])
    canonical.begin(agent, binding.taskId)
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const message = canonical.message(agent, binding, role)
      return { ...decision, messages: [...decision.messages, ...(message ? [message] : [])] }
    }, { prepend: true })
  }
  const guard = new NativeContextGuard(ctx, store, owner, (_owner, reason) => blocked.push(reason), canonical)
  const dispose = guard.install((_agent, _owner, request) => budget.reserve(request, request.maxTokens!),
    (current, request) => canonical?.assertPresent(current, binding, role, request))
  cleanups.push(async () => { dispose(); disposeUsage(); await ctx.fiber.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const send = async (text: string) => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }] }))
    await agent.whenIdle()
  }
  const usage = () => store.listDocumentIds('usage:').map(id => store.readDocument(id)!.value)
  const reserved = () => store.readDocument(`budget:${authorization.authorizationId}`)?.value
  return { ctx, agent, adapter, guard, binding, store, blocked, send, usage, reserved }
}

describe('native final context admission and compaction', () => {
  it('admits a real assembled preset larger than 32k under the physical window without requesting pointless compaction', async () => {
    const { adapter, store, blocked, send, reserved } = await setup([textResponse('Ready.')], {
      capacity: 128000, modelWindowTarget: true, compaction: false,
      extraSystem: 'A registered Host preset instruction with tool guidance. '.repeat(3000),
    })
    await send('Start the local task.')
    const checks = store.listDocumentIds('context-request:').map(id => store.readDocument(id)!.value as {
      admitted: boolean; budget: number; measurement: { inputTokens: number; contextWindow: number; safetyTokens: number; reservedOutputTokens: number }
    })
    expect(checks).toHaveLength(1)
    expect(checks[0]!.measurement.inputTokens).toBeGreaterThan(32000)
    expect(checks[0]!.admitted).toBe(true)
    expect(checks[0]!.budget).toBeLessThan(checks[0]!.measurement.contextWindow - checks[0]!.measurement.reservedOutputTokens)
    expect(adapter.requests).toHaveLength(1)
    expect(reserved()).toMatchObject({ requests: 1, reservedOutputTokens: 512 })
    expect(blocked).toEqual([])
  })
  const compactor = { route: { provider: 'summary-fixture', model: 'summary', reasoningEffort: 'low' }, maxOutputTokens: 256 }

  it.each([{ isolated: false, role: 'lead' }, { isolated: true, role: 'lead' }, { isolated: true, role: 'worker' }] as const)
  ('routes only native summaries through the frozen compactor and records the actual target (%o)', async ({ isolated, role }) => {
    const { agent, adapter, store, blocked, send, reserved, usage } = await setup([
      textResponse('Previous answer'), textResponse('Earlier constraints retained.'), textResponse('Resumed answer'),
    ], { compactor, isolated, role })
    await send('Old background '.repeat(450))
    await send('New request '.repeat(100))
    expect(blocked).toEqual([])
    expect(adapter.requests.map(({ provider, model, purpose, maxTokens }) => ({ provider, model, purpose, maxTokens }))).toEqual([
      { provider: 'fixture', model: role, purpose: undefined, maxTokens: 512 },
      { provider: 'summary-fixture', model: 'summary', purpose: 'compaction', maxTokens: 256 },
      { provider: 'fixture', model: role, purpose: undefined, maxTokens: 512 },
    ])
    expect(adapter.requests[1]!.reasoningEffort).toBe('low')
    expect(Object.isFrozen(adapter.requests[0])).toBe(true)
    expect(agent.session.snapshotEvents().find(event => event.type === 'compaction/summary')).toMatchObject({
      // Host 0.1.5-rc.2 records the post-routing target but its pre-routing cap.
      // The actual cap is proven by the adapter and Fusion usage/context records.
      data: { provider: 'summary-fixture', model: 'summary', maxTokens: 512 },
    })
    expect(agent.session.requestHeader()!.config).toMatchObject({ provider: 'fixture', model: role })
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('Earlier constraints retained.')
    expect(usage().filter((row: any) => row.purpose === 'compaction')).toMatchObject([{
      role, outcome: 'stop', nativeStreamInvocations: 1, upstreamHttpCalls: null, actualSubscriptionChargeUsd: null,
      maxOutputTokens: 256, reasoningEffort: 'low',
      ledger: { key: { provider: 'summary-fixture', model: 'summary' } },
    }])
    expect(reserved()).toMatchObject({ requests: 3, reservedOutputTokens: 1280 })
    const checks = store.listDocumentIds('context-request:').map(id => store.readDocument(id)!.value as any)
    expect(checks.find(row => row.purpose === 'compaction')).toMatchObject({ admitted: true, route: compactor.route,
      measurement: { reservedOutputTokens: 256, contextWindow: 16_000 } })
  })

  it('refuses an unauthorized compactor before dispatch and preserves the original history', async () => {
    const { agent, adapter, blocked, send, reserved, usage } = await setup([textResponse('Previous answer')],
      { compactor, authorizeCompactor: false })
    const original = 'Old background '.repeat(450)
    await send(original)
    await send('New request '.repeat(100))
    expect(adapter.requests).toHaveLength(1)
    expect(reserved()).toMatchObject({ requests: 1, reservedOutputTokens: 512 })
    expect(usage()).toHaveLength(1)
    expect(blocked.at(-1)).toContain('outside this spending authorization')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain(original)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toEqual([])
  })

  it('checks the compactor window instead of the role window, before reserving an oversized summary', async () => {
    const { agent, adapter, store, blocked, send, reserved } = await setup([textResponse('Previous answer')],
      { compactor, compactorCapacity: 1024 })
    const original = 'Old background '.repeat(450)
    await send(original)
    await send('New request '.repeat(100))
    expect(adapter.requests).toHaveLength(1)
    expect(blocked.at(-1)).toContain('压缩失败')
    expect(reserved()).toMatchObject({ requests: 1 })
    const checks = store.listDocumentIds('context-request:').map(id => store.readDocument(id)!.value as any)
    expect(checks.find(row => row.purpose === 'compaction')).toMatchObject({ admitted: false,
      measurement: { contextWindow: 1024, reservedOutputTokens: 256 } })
    expect(JSON.stringify(agent.session.deriveMessages())).toContain(original)
  })

  it('measures the selected summary envelope without charging the other model\'s full history anchor', async () => {
    const { ctx, agent, adapter, send, reserved } = await setup([textResponse('Previous answer'), textResponse('Summary')],
      { compactor, compactorCapacity: 1024 })
    await send('Old background '.repeat(450))
    for await (const _ of ctx.llm.stream({ provider: 'fixture', model: 'lead', purpose: 'compaction', sessionId: agent.id,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize only this selected region.' }] })], maxTokens: 512 })) {}
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'summary-fixture', maxTokens: 256 })
    expect(reserved()).toMatchObject({ requests: 2, reservedOutputTokens: 768 })
  })

  it('fails closed for a frozen summary and leaves ordinary sessions outside compactor routing', async () => {
    const { ctx, agent, adapter, blocked, reserved } = await setup([textResponse('Ordinary summary')], { compactor })
    const ordinary = (await ctx.agents.create({ sessionId: SessionId('ordinary-summary'), agentOptions: { provider: 'fixture', model: 'lead' } })).agent
    const envelope = { provider: 'fixture', model: 'lead', purpose: 'compaction' as const,
      messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'Short summary input' }] })], maxTokens: 512 }
    for await (const _ of ctx.llm.stream({ ...envelope, sessionId: ordinary.id })) {}
    expect(adapter.requests).toMatchObject([{ provider: 'fixture', model: 'lead', maxTokens: 512 }])
    const frozen = Object.freeze({ ...envelope, sessionId: agent.id })
    for await (const _ of ctx.llm.stream(frozen)) {}
    expect(frozen.provider).toBe('fixture')
    expect(adapter.requests).toHaveLength(1)
    expect(blocked.at(-1)).toContain('压缩请求已冻结')
    expect(reserved()).toBeUndefined()
  })

  it('rejects an oversized first input before upstream or spend reservation and preserves it', async () => {
    const { agent, adapter, store, blocked, send, usage, reserved } = await setup([textResponse('must not dispatch')])
    const input = 'Oversized input '.repeat(1000)
    await send(input)
    expect(adapter.requests).toHaveLength(0)
    expect(reserved()).toBeUndefined()
    expect(usage()).toEqual([])
    expect(blocked[0]).toContain('没有可安全压缩的历史')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain(input)
    expect(store.listDocumentIds('context-request:')).toHaveLength(1)
  })

  it('restores canonical facts before the immediate native retry, even when the summary omits them', async () => {
    const { agent, adapter, store, blocked, send, reserved, binding } = await setup([
      // This response has no provider usage. The native mock otherwise reports
      // every character as one output token, creating a false measured anchor.
      textResponse('Old exploration detail. '.repeat(1200)).filter(chunk => chunk.type !== 'usage'),
      textResponse('The earlier requirements were forgotten.'), textResponse('Continue under the retained requirements.'),
    ], { canonical: true, target: 6500 })
    const constraint = 'Preserve test_calc.py and the exact string {{model}}.'
    await send(constraint)
    const feedback = 'Preserve record order and reject duplicate ids after strip and casefold.'
    const artifact = store.putArtifact(binding.taskId, Buffer.from(feedback), 'text/plain')
    store.writeDocument(`worker-delivery:${binding.taskId}:fixture`, 0, { schemaVersion: 1, taskId: binding.taskId,
      briefRevision: 1, payloadRef: artifact.id, causeId: 'native-lead-feedback', state: 'accepted' })
    store.writeDocument(`runtime:${binding.taskId}`, 0, { briefRevision: 1 })
    expect(() => assertWorkerBriefRequest(store, binding.taskId, adapter.requests[0]!)).toThrow('predates the latest Lead brief')
    await send('Continue checking the existing implementation.')
    expect(blocked, JSON.stringify(store.listDocumentIds('context-recovery:').map(id => store.readDocument(id)?.value))).toEqual([])
    expect(adapter.requests.map(request => request.purpose ?? 'conversation')).toEqual(['conversation', 'compaction', 'conversation'])
    const retry = adapter.requests[2]!
    const restored = retry.messages.find(message => message.source?.kind === 'plugin:dsh-model-fusion'
      && message.source.form === 'snapshot')!
    expect(restored).toBeDefined()
    expect(JSON.stringify(restored.content)).toContain(constraint)
    expect(JSON.stringify(restored.content)).toContain(feedback)
    expect(() => assertWorkerBriefRequest(store, binding.taskId, retry)).not.toThrow()
    const checkpoint = store.listDocumentIds('task-checkpoint:').map(id => store.readDocument(id)!.value)
    expect(checkpoint).toMatchObject([{ state: 'committed', taskId: 'context-task', agentId: agent.id, role: 'lead',
      sourceSurfaceSeqs: expect.any(Array), reusedExistingSnapshot: expect.any(Boolean), compactionId: expect.any(String) }])
    expect(reserved()).toMatchObject({ requests: 3 })
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === constraint))).toBe(true)
  })

  it.each([false, true])('uses the native compaction transaction and retries from its checkpoint (isolated preset: %s)', async (isolated) => {
    const { ctx, agent, adapter, store, send, usage, reserved, blocked } = await setup([
      textResponse('Previous answer'), textResponse('Prior task and its constraints retained.'), textResponse('Resumed answer'),
    ], { isolated })
    if (isolated) {
      expect(ctx.get('compaction')).toBeUndefined()
      expect(agent.ctx.get('compaction')).toBeUndefined()
      expect(ctx.agentPresets.serviceFor(agent, 'compaction')).toBeDefined()
    }
    await send('Old background '.repeat(450))
    await send('New request '.repeat(100))
    expect(blocked).toEqual([])
    expect(adapter.requests.map(request => request.purpose ?? 'conversation')).toEqual(['conversation', 'compaction', 'conversation'])
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('Prior task and its constraints retained.')
    const ends = agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data).not.toHaveProperty('error')
    expect(usage().map((value: any) => value.purpose)).toEqual(expect.arrayContaining(['conversation', 'compaction']))
    expect(reserved()).toMatchObject({ requests: 3, reservedOutputTokens: 1536, actualBilledUsd: null })
    expect(store.listDocumentIds('context-request:')).toHaveLength(4)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it.each(['lead', 'worker'] as const)('restores the bounded whole-record suffix on the actual %s retry', async role => {
    const { agent, adapter, store, blocked, send, binding } = await setup([
      textResponse('Old exploration detail. '.repeat(4000)).filter(chunk => chunk.type !== 'usage'),
      textResponse('A deliberately lossy summary.'), textResponse('Continued under the latest handoff.'),
    ], { canonical: true, target: 14_000, capacity: 128_000, role })
    const constraint = 'Keep the public tests unchanged; no new permission is granted.'
    await send(constraint)
    const briefs = ['OLDER-A ' + 'a'.repeat(25_000), 'OLDER-B ' + 'b'.repeat(25_000), 'LATEST ' + 'c'.repeat(30_000)]
    const artifacts = briefs.map((feedback, index) => {
      const artifact = store.putArtifact(binding.taskId, Buffer.from(feedback), 'text/plain')
      store.writeDocument(`worker-delivery:${binding.taskId}:${index}`, 0, { schemaVersion: 1, taskId: binding.taskId,
        briefRevision: index + 1, payloadRef: artifact.id, causeId: `native-feedback-${index}`, state: 'accepted' })
      return artifact
    })
    store.writeDocument(`runtime:${binding.taskId}`, 0, { briefRevision: briefs.length })
    await send('Continue this same task.')
    expect(blocked, JSON.stringify({ recovery: store.listDocumentIds('context-recovery:').map(id => store.readDocument(id)?.value),
      checks: store.listDocumentIds('context-request:').map(id => store.readDocument(id)?.value) })).toEqual([])
    expect(adapter.requests.map(request => request.purpose ?? 'conversation'), JSON.stringify({
      recovery: store.listDocumentIds('context-recovery:').map(id => store.readDocument(id)?.value),
      checks: store.listDocumentIds('context-request:').map(id => store.readDocument(id)?.value),
      checkpoints: store.listDocumentIds('task-checkpoint:').map(id => store.readDocument(id)?.value),
    })).toEqual(['conversation', 'compaction', 'conversation'])
    const retry = adapter.requests[2]!
    const section = retry.messages.flatMap(message => message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot'
      ? message.source.sections.filter(section => section.name === FUSION_TASK_CONTEXT) : []).at(-1)!
    const facts = JSON.parse(section.text.slice(section.text.indexOf('\n') + 1)).facts
    expect(retry.messages.flatMap(message => message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot'
      ? message.source.sections.filter(candidate => candidate.name === FUSION_TASK_CONTEXT && candidate.text === section.text) : [])).toHaveLength(1)
    expect(facts.workerHandoffs).toMatchObject({ contentByteBudget: 40_000, totalRecords: 3, omittedRecords: 2,
      latestBriefRevision: 3, retainedContentBytes: 30_007, records: [{ revision: 3, content: briefs[2] }] })
    expect(facts.userInstructions[0].text).toEqual([constraint])
    expect(JSON.stringify(retry.messages)).not.toContain(briefs[0])
    expect(JSON.stringify(retry.messages)).not.toContain(briefs[1])
    expect(() => assertWorkerBriefRequest(store, binding.taskId, retry)).not.toThrow()
    artifacts.forEach((artifact, index) => expect(Buffer.from(store.readArtifact(binding.taskId, artifact.id)).toString('utf8')).toBe(briefs[index]))
    const checkpoints = store.listDocumentIds('task-checkpoint:').map(id => store.readDocument(id)!.value as { replacedSnapshotSeq: number })
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]!.replacedSnapshotSeq).toEqual(expect.any(Number))
    expect(agent.session.surface.nodes).not.toContain(checkpoints[0]!.replacedSnapshotSeq)
    // The routine snapshot that compaction replaced pinned only digests; the full brief is restored after it.
    expect(JSON.stringify(agent.session.snapshotEvents().find(event => event.seq === checkpoints[0]!.replacedSnapshotSeq))).toContain('contentDigest')
    const later = store.putArtifact(binding.taskId, Buffer.from('A later brief must fence the already assembled retry.'), 'text/plain')
    store.writeDocument(`worker-delivery:${binding.taskId}:later`, 0, { schemaVersion: 1, taskId: binding.taskId,
      briefRevision: 4, payloadRef: later.id, causeId: 'native-later-feedback', state: 'accepted' })
    store.writeDocument(`runtime:${binding.taskId}`, 1, { briefRevision: 4 })
    expect(() => assertWorkerBriefRequest(store, binding.taskId, retry)).toThrow('predates the latest Lead brief')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('preserves an oversized latest handoff intact and blocks dispatch when the model cannot fit it', async () => {
    const { adapter, store, blocked, send, binding, reserved } = await setup([], { canonical: true, target: 6500 })
    const content = 'LATEST ' + 'x'.repeat(40_001)
    const artifact = store.putArtifact(binding.taskId, Buffer.from(content), 'text/plain')
    store.writeDocument(`worker-delivery:${binding.taskId}:large`, 0, { schemaVersion: 1, taskId: binding.taskId,
      briefRevision: 1, payloadRef: artifact.id, causeId: 'native-large-feedback', state: 'accepted' })
    store.writeDocument(`runtime:${binding.taskId}`, 0, { briefRevision: 1 })
    await send('Continue.')
    expect(adapter.requests).toHaveLength(0)
    expect(reserved()).toBeUndefined()
    expect(blocked).toHaveLength(1)
    expect(blocked[0]).toContain('必须保留的任务内容')
    const saved = store.readDocument(`task-context:${binding.taskId}:lead`)!.value as { artifact: { id: string } }
    const facts = JSON.parse(Buffer.from(store.readArtifact(binding.taskId, saved.artifact.id)).toString('utf8'))
    expect(facts.workerHandoffs).toMatchObject({ retainedContentBytes: 40_008, records: [{ content }] })
    expect(Buffer.from(store.readArtifact(binding.taskId, artifact.id)).toString('utf8')).toBe(content)
  })

  it('retains original history and stops after a failed summary without retrying upstream', async () => {
    const { agent, adapter, store, blocked, send, reserved } = await setup([
      textResponse('Previous answer'), toolCallResponse('summary-tool', 'unexpected_tool', {}),
    ])
    const old = 'Old background '.repeat(450)
    await send(old)
    await send('New request '.repeat(100))
    expect(adapter.requests).toHaveLength(2)
    expect(blocked.at(-1)).toContain('压缩失败')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain(old)
    expect(store.listDocumentIds('context-recovery:').map(id => store.readDocument(id)!.value)).toMatchObject([{ state: 'blocked', attempts: 1 }])
    expect(reserved()).toMatchObject({ requests: 2, reservedOutputTokens: 1024 })
  })

  it('counts auxiliary calls tagged by session even outside an initiator scope', async () => {
    const { ctx, agent, adapter, reserved, usage } = await setup([textResponse('Summary')])
    for await (const _chunk of ctx.llm.stream({ provider: 'fixture', model: 'lead', sessionId: agent.id, purpose: 'compaction',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize this small input' }] })], maxTokens: 512 })) {}
    expect(adapter.requests).toHaveLength(1)
    expect(reserved()).toMatchObject({ requests: 1, reservedOutputTokens: 512 })
    expect(usage()).toMatchObject([{ purpose: 'compaction', role: 'lead', actualSubscriptionChargeUsd: null }])
  })

  it('caps compaction attempts when a retained input still cannot fit', async () => {
    const { adapter, store, send, blocked, reserved } = await setup([
      textResponse('Previous answer'), textResponse('First summary.'.repeat(130)), textResponse('Shorter.'.repeat(90)),
    ])
    await send('Old '.repeat(1000))
    await send('Retained '.repeat(760))
    expect(adapter.requests.map(request => request.purpose ?? 'conversation')).toEqual(['conversation', 'compaction', 'compaction'])
    expect(blocked.at(-1)).toContain('Fusion 已暂停')
    expect(store.listDocumentIds('context-recovery:').map(id => store.readDocument(id)!.value)).toMatchObject([{ state: 'blocked', attempts: 2 }])
    expect(reserved()).toMatchObject({ requests: 3, reservedOutputTokens: 1536 })
  })

  it('checks the physical window for summaries and keeps title failures out of task control', async () => {
    const { ctx, agent, adapter, blocked, reserved } = await setup([], { capacity: 2048 })
    const stream = (purpose: 'compaction' | 'session-title') => ctx.llm.stream({ provider: 'fixture', model: 'lead', sessionId: agent.id,
      purpose, messages: [createUserMessage({ content: [{ type: 'text', text: 'Huge input '.repeat(1000) }] })], maxTokens: 512 })
    for await (const _chunk of stream('session-title')) {}
    expect(blocked).toEqual([])
    for await (const _chunk of stream('compaction')) {}
    expect(blocked).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    expect(reserved()).toBeUndefined()
  })

  it('counts a newly assembled tool schema and fails closed when model capacity is unknown', async () => {
    const { adapter, send, blocked } = await setup([textResponse('must not dispatch')], { capacity: null })
    await send('A small request')
    expect(adapter.requests).toHaveLength(0)
    expect(blocked[0]).toContain('context window')
    const withCapacity = await setup([])
    const request = { provider: 'fixture', model: 'lead', maxTokens: 512, messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }] })] }
    const plain = await withCapacity.guard.measure(withCapacity.agent, { binding: withCapacity.binding, role: 'lead' }, request)
    const large = await withCapacity.guard.measure(withCapacity.agent, { binding: withCapacity.binding, role: 'lead' }, {
      ...request, tools: [{ name: 'large', description: 'Schema description '.repeat(1000), parameters: { type: 'object', properties: {} } }],
    })
    expect(large.measurement.inputTokens).toBeGreaterThan(large.budget)
    expect(large.measurement.inputTokens).toBeGreaterThan(plain.measurement.inputTokens + 4000)
    expect(large.measurement.quality).toBe('heuristic')
  })
})
