import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { createUserMessage, ToolCallId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import * as ToolTimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse, maxTokensResponse } from '@fusion-host-test/mock-adapter'
import { TestSessionQuery } from '@fusion-host-test/session-query'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { mountNativeShell, shellTool, shellCommand, py, python } from './shell-fixture.js'
import CodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { FusionCoordinator } from '../src/host/coordinator.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { completeProfile } from '../src/profile/resolve.js'
import { loadPromptBundle } from '../src/prompts.js'
import { FusionCatalogAdapter, FUSION_PROVIDER, FUSION_MODEL, installNativeFusionSelection } from '../src/host/native-selection.js'
import { FUSION_TASK_CONTEXT } from '../src/host/native-task-context.js'
import { KEEPALIVE_ATTEMPTS, KEEPALIVE_INTERVAL_MS, KEEPALIVE_PROMPT } from '../src/host/native-keepalive.js'
import type { KeepaliveClock, KeepaliveRecord } from '../src/host/native-keepalive.js'
import type { NativeUsageRecord } from '../src/host/native-usage.js'
import { NativeRequestBudget, authorizeConfiguredPair } from '../src/host/native-budget.js'
import { readFusionStatus } from '../src/host/status.js'
import { readModelControl } from '../src/host/native-model-control.js'
import { readHistory } from '../src/host/history.js'
import { ManualKeepaliveClock } from './fixtures/keepalive-clock.js'
import { NativeFusionActivity, readFusionActivity, readHistoricalFusionActivity } from '../src/host/native-activity.js'
import { activityRows } from '../src/client/activity-model.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Windows process startup can exceed Vitest's one-second polling default. */
function waitForNative<T>(callback: () => T, options?: Parameters<typeof vi.waitFor>[1]) {
  return vi.waitFor(callback, options ?? { timeout: process.platform === 'win32' ? 10_000 : 1000 })
}

/** Keep native settlement notices from consuming the next user turn's script. */
function holdLeadForFollowup(adapter: MockAdapter, initialLeadResponses = 2) {
  let released = false
  const stream = adapter.stream.bind(adapter)
  vi.spyOn(adapter, 'stream').mockImplementation(async function* (request) {
    if (!released && request.model === 'lead'
      && adapter.requests.filter(item => item.model === 'lead').length >= initialLeadResponses) {
      adapter.requests.push(request)
      yield* textResponse('Awaiting the user continuation decision.')
      return
    }
    yield* stream(request)
  })
  return () => { released = true }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]
async function setup(script: Script, workerScript?: Script, options: {
  keepalive?: { lead: boolean; worker: boolean }; clock?: KeepaliveClock; auxiliaryScript?: Script; maxRequests?: number; workerTarget?: number; jobs?: boolean; commandMaxSeconds?: number
  outputTokens?: { lead: number; worker: number }
  retryMode?: 'normal' | 'always'
  parentMaxTokens?: number
  maxWorkerSteps?: number
  maxReworkRounds?: number
  adapterOutput?: { lead: number; worker: number } | null
  files?: boolean
  toolMode?: 'native' | 'both'
  presetTools?: boolean
  modelLike?: boolean
  enforcedWorkflow?: boolean | 'enforced-v2' | 'enforced-v3'
  /** Register a sandbox-policy service that folds `sandbox/mode` events like the Host's. */
  sandbox?: boolean
  noCwd?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fusion-coordinator-'))
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  writeFileSync(join(workspace, 'test_calc.py'), 'import unittest\nfrom calc import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
  const ctx = new Context()
  const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.toolMode ?? 'native' } })
  if (options.toolMode === 'both') {
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSandbox)
    if (!options.sandbox) await ctx.plugin(SandboxPolicy)
    await ctx.plugin(CodeRuntime, {})
  }
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  if (options.sandbox) {
    const modeOf = (session: { snapshotEvents(): { type: string; data: unknown }[] }) =>
      (session.snapshotEvents().filter(event => event.type === 'sandbox/mode').at(-1)?.data as { mode?: string } | undefined)?.mode
    ctx.provide('sandboxPolicy', { overrideOf: modeOf, resolve: ({ session }: { session?: Parameters<typeof modeOf>[0] } = {}) =>
      ({ mode: (session && modeOf(session)) ?? 'workspace-write', workspaceRoot: workspace }) } as never)
  }
  await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: process.platform === 'win32' ? 15_000 : 5000, jobs: options.jobs })
  if (options.files) {
    if (options.toolMode !== 'both') await ctx.plugin(LocalFileSystem, { cwd: workspace })
    if (!options.presetTools) await ctx.plugin(ToolFs, {})
  }
  if (options.presetTools) {
    const presets = join(root, 'presets'), preset = join(presets, 'scoped-files')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), '- id: files\n  name: cordis:fixture-files\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['fixture-files'] = ToolFs
    await ctx.plugin(AgentPresets, { default: 'scoped-files' })
    await ctx.agentPresets.register({ id: 'scoped-files', plugins: parseYaml(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')) })
    ctx.on('agent/created', ({ agent }) => {
      if (!agent.session.header.parentSession) return
      agent.ctx.tools.register(defineTool({ name: 'child_local_probe', description: 'An unrelated agent-local capability', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
        execute: async () => { writeFileSync(join(workspace, 'must-not-exist'), 'effect'); return 'effect' } }))
    })
  }
  const workerAdapter = workerScript && new MockAdapter(workerScript)
  const auxiliaryAdapter = options.auxiliaryScript && new MockAdapter(options.auxiliaryScript)
  const modelContext = { window: 128_000 }
  class ContextAdapter extends MockAdapter {
    override providerRetryPolicy() {
      return options.retryMode ? resolveRetryPolicy({ mode: options.retryMode, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'fixture') : undefined
    }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (auxiliaryAdapter && options.maxTokens === 1) {
        this.requests.push(options)
        yield* auxiliaryAdapter.stream(options)
      } else if (workerAdapter && options.model === 'worker') {
        this.requests.push(options)
        yield* workerAdapter.stream(options)
      } else yield* super.stream(options)
    }
    override async resolveModel(provider: string, model: string) {
      return { ...await super.resolveModel(provider, model), context: { contextWindow: modelContext.window },
        defaultMaxTokens: options.adapterOutput === null ? undefined : options.adapterOutput?.[model === 'worker' ? 'worker' : 'lead'] ?? 8000 }
    }
  }
  const adapter = new ContextAdapter(script)
  ctx.llm.registerAdapter(['test-native'], adapter)
  const parent = (await ctx.agents.create({ sessionId: SessionId('lead'), meta: options.noCwd ? {} : { cwd: workspace },
    ...(options.presetTools ? { setup: async (scope: Context) => { await ctx.agentPresets.mount(scope, 'scoped-files') } } : {}),
    agentOptions: { provider: 'test-native', model: 'ordinary', maxTokens: options.parentMaxTokens } })).agent
  const selectionRef = { current: { provider: 'test-native', model: 'ordinary' }, assembled: undefined }
  installModelSelection(parent.ctx, selectionRef)
  const prompts = loadPromptBundle()
  const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
    ...(options.keepalive ? { cacheKeepalive: options.keepalive } : {}),
    context: {
      lead: options.outputTokens ? { reserveOutputTokens: options.outputTokens.lead } : {},
      worker: { ...(options.workerTarget ? { targetInputTokens: options.workerTarget } : {}),
        ...(options.outputTokens ? { reserveOutputTokens: options.outputTokens.worker } : {}) },
    },
    ...(options.modelLike ? { interactionMode: 'model-like' } : {}),
    ...(options.enforcedWorkflow ? { workflowPolicy: options.enforcedWorkflow === true ? 'enforced-v1' : options.enforcedWorkflow } : {}), lead: { provider: 'test-native', model: 'lead' }, worker: { provider: 'test-native', model: 'worker' }, dataPolicyId: 'fixture-only' }, prompts)
  const budget = options.keepalive && new NativeRequestBudget(store)
  const authorization = budget && authorizeConfiguredPair(store, [profile.lead, profile.worker], {
    acknowledgeAccountUsage: true, acknowledgeUnknownCost: true, validHours: 1,
    maxNativeRequests: options.maxRequests ?? 100, maxReservedOutputTokens: 1_000_000,
  })
  const coordinator = new FusionCoordinator(ctx, store, { profile: { profile, prompts }, leaseRoot: join(root, 'leases'),
    workerTools: [...(options.jobs ? [shellTool, 'job_output', 'job_kill'] : [shellTool]), ...(options.files ? ['read', 'write', 'edit'] : [])], keepaliveClock: options.clock,
    commandMaxSeconds: options.commandMaxSeconds,
    maxWorkerSteps: options.maxWorkerSteps, maxReworkRounds: options.maxReworkRounds,
    authorizeRequest: () => { /* scripted in-process adapter: no upstream or bill */ },
    reserveRequest: request => { budget && budget.reserve(request, request.maxTokens!) } })
  cleanups.push(async () => { await coordinator.close(); await ctx.fiber.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) })
  await coordinator.select(parent)
  const taskId = coordinator.bindings.read(parent.id)!.binding.taskId
  return { ctx, parent, coordinator, store, adapter, taskId, workspace, selectionRef, authorization, modelContext }
}

const delegate = (block = true, checkTimeoutSeconds?: number) => toolCallResponse('delegate', 'fusion_delegate', {
  block,
  goal: 'Correct addition', brief: 'Fix calc.py add and preserve the test. Submit a report after implementing.',
  constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'],
  checks: [{ id: 'addition', description: 'Existing addition test passes', command: py('python3 -B -m unittest -v test_calc'),
    kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'],
    ...(checkTimeoutSeconds === undefined ? {} : { timeoutSeconds: checkTimeoutSeconds }) }],
})
const edit = (id = 'edit') => toolCallResponse(id, shellTool, { command: shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\")"), description: 'Correct the addition implementation' })
const report = (id = 'report') => toolCallResponse(id, 'fusion_submit_result', { summary: 'Corrected add in calc.py.', status: 'completed', unresolved: [] })
const review = (decision: 'accept' | 'rework') => toolCallResponse(`review-${decision}`, 'fusion_review_result', { decision, reason: decision === 'accept' ? 'The implementation adds both inputs and the frozen native test passed.' : 'The candidate needs a further implementation pass.' })
/** enforced-v3 handoff: the user's hard requirement quoted verbatim ('addition' occurs in the v3 test prompts). */
const delegateV3 = (block = true, requirements = ['addition']) => toolCallResponse('delegate', 'fusion_delegate', {
  block, requirements,
  goal: 'Correct addition', brief: 'Fix calc.py add and preserve the test. Submit a report after implementing.',
  constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'],
  checks: [{ id: 'addition', description: 'Existing addition test passes', command: py('python3 -B -m unittest -v test_calc'),
    kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
})
const acceptV3 = (id = 'review-accept') => toolCallResponse(id, 'fusion_review_result', { decision: 'accept',
  reason: 'The implementation adds both inputs and the frozen native test passed.',
  requirements: [{ index: 1, met: true, evidence: 'calc.py add returns a + b; test_calc passed natively' }] })

const explore = (block = true) => toolCallResponse('explore', 'fusion_explore', {
  goal: 'Locate the addition bug', brief: 'Read the addition implementation and tests. Return source findings so I can plan the fix.', constraints: ['Do not change files'], block,
})
const findings = (id = 'findings') => toolCallResponse(id, 'fusion_submit_result', {
  status: 'completed', summary: 'calc.py subtracts; test_calc.py expects addition. The Lead should decide the correction.', unresolved: [],
  sources: [{ path: 'calc.py', startLine: 1, endLine: 2 }],
})
const readCalc = () => toolCallResponse('read-calc', 'read', { file_path: 'calc.py' })

describe('delegation preflight and direct preparation', () => {
  const withDefinitions = (paths: string[]) => toolCallResponse('invalid-delegate', 'fusion_delegate', {
    goal: 'Correct addition', brief: 'Fix calc.py and add regression tests when needed.',
    constraints: ['Preserve existing tests'], allowedPaths: ['calc.py', 'future_test.py'],
    checks: [{ id: 'addition', description: 'Existing and new tests pass', command: py('python3 -B -m unittest -v test_calc'),
      kind: 'test', parser: 'unittest', definitionPaths: paths }],
  })

  it.each(['future_test.py', '.'])('explains an unusable frozen definition %s and permits a corrected handoff on the same task', async path => {
    const { parent, coordinator, store, taskId } = await setup([
      withDefinitions(['test_calc.py', path]), delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    const errors = toolResults(parent).map(result => result.message)
      .filter(block => block.role === 'tool' && block.isError)
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors)).toContain('definitionPaths must name existing regular files')
    expect(JSON.stringify(errors)).toContain('new regression tests belong in allowedPaths')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.events(taskId).filter(event => event.type === 'work-order/prepared')).toHaveLength(1)
    expect(store.events(taskId).filter(event => event.type === 'child/accepted')).toHaveLength(1)
  })

  it('preserves the direct writer after failed preflight and transfers it only for the valid work order', async () => {
    const { parent, coordinator, store, adapter, taskId, workspace } = await setup([
      toolCallResponse('take', 'fusion_takeover', { reason: 'Prepare a small local note before delegating.' }),
      withDefinitions(['test_calc.py', 'future_test.py']),
      toolCallResponse('prepare', shellTool, { command: shellCommand("printf 'prepared\\n' > prep.txt", "[IO.File]::WriteAllText((Join-Path $PWD 'prep.txt'), \"prepared`n\")"), description: 'Finish direct preparation' }),
      delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()], { files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare a note, then delegate the addition fix.' }] }))
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'prep.txt'), 'utf8')).toBe('prepared\n')
    const errors = toolResults(parent).map(result => result.message)
      .filter(block => block.role === 'tool' && block.isError)
    expect(errors, JSON.stringify(toolResults(parent))).toHaveLength(1)
    expect(JSON.stringify(errors)).toContain('definitionPaths must name existing regular files')
    const state = coordinator.state(taskId)
    expect(state, JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(coordinator.bindings.read(parent.id)!.binding.taskId).toBe(taskId)
    const events = store.events(taskId)
    const handoff = events.findIndex(event => event.type === 'work-order/prepared')
    const acquired = events.filter(event => event.type === 'lease/acquired')
    expect(acquired[0]!.payload.lease.holder).toBe(parent.id)
    expect(acquired[1]!.payload.lease.holder).toBe(state.acceptedChild)
    expect(acquired[1]!.payload.lease.generation).toBeGreaterThan(acquired[0]!.payload.lease.generation)
    expect(events.slice(0, handoff).some(event => event.type === 'lease/released')).toBe(true)
    expect(events.slice(0, handoff).some(event => event.type === 'task/completed')).toBe(false)
    const leadRequests = adapter.requests.filter(request => request.model === 'lead')
    expect(leadRequests[2]!.tools!.some(tool => tool.name === shellTool)).toBe(true)
    expect(leadRequests[4]!.tools!.some(tool => tool.name === shellTool)).toBe(false)
  })

  it('keeps a live direct job and its writer until collection, then delegates without replaying the job', async () => {
    let gate = ''
    const { parent, coordinator, store, taskId, workspace } = await setup([
      toolCallResponse('take', 'fusion_takeover', { reason: 'Prepare the implementation before delegating.' }),
      () => backgroundEdit(gate), delegate(), request => waitForJob(request),
      delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()], { jobs: true })
    gate = join(workspace, '..', 'release-direct-handoff')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare addition and delegate the final check.' }] }))
    await waitForNative(() => expect(coordinator.effects.waitingForJob(parent)).toBe(true))
    expect(coordinator.state(taskId).lease?.holder).toBe(parent.id)
    expect(coordinator.state(taskId).acceptedChild).toBeUndefined()
    expect(JSON.stringify(toolResults(parent))).toContain('Settle the current writer and effects')
    expect(store.events(taskId).filter(event => event.type === 'work-order/prepared')).toHaveLength(0)
    writeFileSync(gate, 'release')
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(coordinator.effects.pending(taskId)).toEqual([])
    const jobs = store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value as { nativeJob?: { status: string } })
      .filter(record => record.nativeJob)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.nativeJob?.status).toBe('completed')
  })
})

describe('read-only exploration before a Lead plan', () => {
  it('advertises only usable Lead tools before a lease, restores writes for takeover and masks them after release and rollover', async () => {
    const { parent, coordinator, adapter, workspace } = await setup([
      readCalc(), toolCallResponse('take', 'fusion_takeover', { reason: 'Small direct correction.' }), edit(),
      toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Done.'),
      readCalc(), textResponse('It adds both inputs.'),
    ], undefined, { files: true, presetTools: true, toolMode: 'both' })
    const initial = coordinator.bindings.read(parent.id)!.binding.taskId
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Now explain add without changing it.' }] }))
    await parent.whenIdle()
    expect(coordinator.bindings.read(parent.id)!.binding.taskId).not.toBe(initial)
    const toolNames = adapter.requests.map(request => request.tools!.map(tool => tool.name))
    for (const index of [0, 1, 4, 5, 6]) {
      expect(toolNames[index]).toContain('read')
      expect(toolNames[index]).toContain('fusion_delegate')
      for (const name of [shellTool, 'write', 'edit', 'run_code', 'subagent', 'list_subagent_models']) expect(toolNames[index]).not.toContain(name)
    }
    for (const index of [2, 3]) expect(toolNames[index]).toEqual(expect.arrayContaining([shellTool, 'write', 'edit', 'run_code']))
    expect(toolResults(parent).map(result => result.message).filter(block => block.role === 'tool' && block.isError)).toEqual([])
  })

  it('keeps Lead read presentation from reducing the persistent Worker capability ceiling', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([
      delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()], { files: true, presetTools: true, toolMode: 'both' })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    for (const request of adapter.requests.filter(request => request.model === 'lead')) {
      expect(request.tools!.map(tool => tool.name)).toContain('read')
      for (const name of [shellTool, 'write', 'edit', 'run_code']) expect(request.tools!.map(tool => tool.name)).not.toContain(name)
    }
    for (const request of adapter.requests.filter(request => request.model === 'worker')) {
      expect(request.tools!.map(tool => tool.name)).toEqual(expect.arrayContaining([shellTool, 'write', 'edit', 'run_code']))
    }
  })

  it('returns actionable blocked exploration and permits feedback to the same Worker without accepting the failure', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      explore(), toolCallResponse('finish-blocked', 'fusion_finish_direct', {}), textResponse('I need the missing source.'),
      toolCallResponse('retry-same-worker', 'fusion_rework', { feedback: 'The source is calc.py; inspect its two lines.' }),
      toolCallResponse('finish-answer', 'fusion_finish_direct', {}), textResponse('It subtracts.'),
    ], [toolCallResponse('blocked-report', 'fusion_submit_result', { status: 'blocked', summary: 'Source not located.', unresolved: ['Need source location.'], sources: [] }), findings()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain the code.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId), childId = state.acceptedChild
    expect(state).toMatchObject({ phase: 'PLANNING', exploration: { status: 'blocked' }, verification: 'unverified' })
    expect(state.acceptedReview).toBeUndefined()
    expect(JSON.stringify(toolResults(parent))).toContain('exploration-blocked')
    expect(JSON.stringify(toolResults(parent))).toContain('fusion_rework')
    expect(JSON.stringify(toolResults(parent))).toContain('Explain the blocker and end this turn')
    expect(readFusionStatus(store, parent.id).task).toMatchObject({ stage: '等待反馈', attention: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'The source is calc.py.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'unverified', acceptedChild: childId })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(0)
  })

  it('keeps Worker closing transcript out of actual Lead requests while retaining the structured report', async () => {
    const closing = 'worker-closing-transcript-only-marker'
    const closingReport = toolCallResponse('closing-report', 'fusion_submit_result', {
      summary: 'Structured report: corrected addition.', status: 'completed', unresolved: [],
    }, closing)
    const { parent, adapter, coordinator, store, taskId } = await setup(
      [delegate(), review('accept'), textResponse('Verified.')], [edit(), closingReport])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and preserve tests.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    const leadRequests = adapter.requests.filter(request => request.model === 'lead').slice(1)
    expect(leadRequests).toHaveLength(2)
    expect(JSON.stringify(leadRequests.map(request => request.messages))).toContain('Structured report: corrected addition.')
    expect(JSON.stringify(leadRequests.map(request => request.messages))).not.toContain(closing)
    const notices = store.listDocumentIds(`worker-notice:${taskId}:`).map(id => store.readDocument(id)!.value as { artifact: { id: string } })
    expect(notices).toHaveLength(1)
    expect(Buffer.from(store.readArtifact(taskId, notices[0]!.artifact.id)).toString()).toContain(closing)
    const constraint = coordinator.state(taskId).currentWorkOrder!.constraints[0]!
    const instruction = parent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source?.kind === 'user')!
    expect(constraint.source).toMatchObject({ sessionId: parent.id, eventSeq: instruction.seq })
  })

  it('projects legacy Worker notices before native compaction after controller replacement and preserves their source events', async () => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), textResponse('Candidate ready; review later.'), textResponse('Native summary.'),
      review('accept'), textResponse('Verified after restore.'),
    ], [edit(), report()])
    await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const childId = coordinator.state(taskId).acceptedChild!
    const raw = createUserMessage({ source: { kind: 'subagent-settled', form: 'notice', senderSessionId: SessionId(childId), summary: 'Worker failed before it finished.' },
      content: [{ type: 'text', text: 'legacy-closing-private' }, { type: 'reasoning', text: 'legacy-worker-reasoning' },
        { type: 'tool-call', id: ToolCallId('legacy-worker-call'), name: 'fusion_submit_result', arguments: '{}' }] })
    const original = parent.session.append('user/message', raw, { surfaceOp: 'append' })
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    let compacted = false
    const dispose = parent.ctx.on('agent/pre-step', async ({ signal }, next) => {
      if (!compacted) {
        compacted = true
        expect(JSON.stringify(parent.session.deriveMessages())).not.toContain('legacy-worker-reasoning')
        const nodes = parent.session.surface.nodes.filter(seq => parent.session.eventAt(seq)?.type !== 'system/message')
        expect(await ctx.compaction.compactRegion(nodes[0]!, nodes.at(-1)!, parent, signal)).not.toBeNull()
      }
      return next()
    })
    cleanups.push(async () => dispose())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review now.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(compacted).toBe(true)
    expect(restored.state(taskId), JSON.stringify(parent.session.snapshotEvents().filter(event => event.type === 'turn/end' || event.type === 'compaction/end'))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    const summaryRequest = adapter.requests.find(request => request.purpose === 'compaction')!
    expect(summaryRequest).toBeDefined()
    expect(JSON.stringify(summaryRequest.messages)).not.toContain('legacy-worker-reasoning')
    expect(JSON.stringify(summaryRequest.messages)).toContain('Worker failed before it finished.')
    expect(parent.session.eventAt(original.seq)?.data).toEqual(raw)
    expect(parent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.sourceEventSeqs?.includes(original.seq) && event.data.source?.kind === 'plugin:dsh-model-fusion')).toBe(true)
    const records = store.listDocumentIds(`worker-notice:${taskId}:`).map(id => store.readDocument(id)!.value as { originalMessageId: string; artifact: { id: string } })
    const record = records.find(row => row.originalMessageId === raw.id)!
    expect(JSON.parse(Buffer.from(store.readArtifact(taskId, record.artifact.id)).toString())).toEqual(raw)
  })

  it('retains failure status without inventing a report and leaves human and unrelated child messages intact', async () => {
    const { parent, ctx, coordinator, adapter, store, taskId } = await setup(
      [delegate(), textResponse('The Worker did not submit a report.'), textResponse('Failure notice received.'), textResponse('Awaiting a decision.')],
      [readCalc(), [{ type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_FAILED', message: 'fixture worker failure' } } }]], { files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'lead').some(request =>
      JSON.stringify(request.messages).includes('failed before it finished'))).toBe(true))
    await parent.whenIdle()
    const afterFailure = adapter.requests.filter(request => request.model === 'lead').at(-1)!
    expect(JSON.stringify(afterFailure.messages)).toContain('failed before it finished')
    expect(JSON.stringify(afterFailure.messages)).toContain('Worker stopped without fusion_submit_result')
    expect(coordinator.state(taskId).candidateReport).toBeUndefined()
    const unrelated = createUserMessage({ source: { kind: 'subagent-settled', form: 'notice', senderSessionId: SessionId('unrelated-child'), summary: 'An unrelated child finished.' },
      content: [{ type: 'text', text: 'Keep unrelated closing content.' }] })
    const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep my literal subagent-settled explanation.' }] })
    parent.followup(unrelated); parent.followup(human)
    await parent.whenIdle()
    const leadMessages = adapter.requests.filter(request => request.model === 'lead').at(-1)!.messages
    expect(leadMessages).toContainEqual(unrelated)
    expect(leadMessages).toContainEqual(human)
    const before = store.listDocumentIds(`worker-notice:${taskId}:`).length
    // Scoped Fusion hooks do not run on this ordinary Agent. Its public input
    // remains byte-identical even if it mentions an owned Worker identity.
    const plainAdapter = new MockAdapter([textResponse('Ordinary answer.')])
    ctx.llm.registerAdapter(['ordinary-fixture'], plainAdapter)
    const ordinary = (await ctx.agents.create({ sessionId: SessionId('unrelated-parent'), agentOptions: { provider: 'ordinary-fixture', model: 'ordinary' } })).agent
    ordinary.followup(unrelated)
    await ordinary.whenIdle()
    expect(plainAdapter.requests[0]!.messages).toContainEqual(unrelated)
    expect(plainAdapter.requests[0]!.tools?.some(tool => tool.name.startsWith('fusion_'))).not.toBe(true)
    expect(store.listDocumentIds(`worker-notice:${taskId}:`)).toHaveLength(before)
  })

  it('advances a stage brief on the same Worker without changing durable constraints or accepting unfinished work', async () => {
    const temporary = 'Stage one: inspect the defect; defer correcting addition until stage two.'
    const { parent, coordinator, store, adapter, taskId } = await setup([
      toolCallResponse('staged-delegate', 'fusion_delegate', { goal: 'Correct addition and preserve tests.', brief: temporary,
        constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'],
        checks: [{ id: 'addition', description: 'Addition works', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }] }),
      review('accept'), toolCallResponse('stage-two', 'fusion_rework', { feedback: 'Advance to stage two: implement addition in calc.py.' }),
      review('accept'), textResponse('Both stages completed.'),
    ], [toolCallResponse('stage-one-report', 'fusion_submit_result', { summary: 'Inspected the defect.', status: 'completed', unresolved: ['Addition still needs correction in stage two.'] }), edit(), report()])
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect, then fix addition. Preserve the tests.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId)
    expect(state, JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.events(taskId).filter(event => event.type === 'work-order/prepared')).toHaveLength(1)
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    expect(state.currentWorkOrder!.constraints.map(item => item.text)).toEqual(['Do not change test_calc.py'])
    const finalRequest = adapter.requests.filter(request => request.model === 'worker').at(-1)!
    const finalWorker = taskSnapshot(finalRequest)
    expect(finalWorker.workerHandoffs).toMatchObject({ latestBriefRevision: 1, totalRecords: 2 })
    expect(finalWorker.workerHandoffs.records.every((record: { content?: string; contentDigest?: string }) => record.content === undefined && record.contentDigest)).toBe(true)
    expect(JSON.stringify(finalRequest.messages)).toContain(temporary)
    expect(JSON.stringify(finalRequest.messages)).toContain('Advance to stage two')
    expect(toolResults(parent).some(result => result.message.role === 'tool' && result.message.isError)).toBe(true)
  })

  it('returns real snippets, then implements and verifies with the same Worker and visible activity', async () => {
    const { parent, coordinator, store, adapter, taskId, ctx } = await setup(
      [explore(), delegate(), review('accept'), textResponse('Fixed and verified.')],
      [readCalc(), findings(), edit(), report()], { files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find and fix the addition bug.' }] }))
    await parent.whenIdle(); await coordinator.activity.flush()
    const state = coordinator.state(taskId)
    expect(state, JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', currentWorkOrder: { mode: 'implement' } })
    const orders = store.events(taskId).filter(event => event.type === 'work-order/prepared')
    expect(orders.map(event => event.payload.order.mode)).toEqual(['explore', 'implement'])
    expect(new Set(orders.map(event => event.payload.reservedChild)).size).toBe(1)
    expect(orders[0]!.payload.order.allowedPaths).toEqual([])
    expect(state.exploration?.sources[0]?.fileDigest).toBeDefined()
    expect(Buffer.from(store.readArtifact(taskId, state.exploration!.sources[0]!.excerpt.id)).toString()).toBe('def add(a, b):\n    return a - b')
    const recorded = store.events(taskId).find(event => event.type === 'exploration/recorded')!
    expect(store.events(taskId).filter(event => event.type === 'lease/acquired').every(event => event.seq > recorded.seq)).toBe(true)
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(1)
    const implementation = adapter.requests.filter(request => request.model === 'worker').find(request => taskSnapshot(request).workOrder.mode === 'implement')!
    const exploration = adapter.requests.filter(request => request.model === 'worker' && taskSnapshot(request).workOrder.mode === 'explore')
    expect(exploration).toHaveLength(2)
    for (const request of exploration) {
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['fusion_read_evidence', 'fusion_submit_result', 'read'])
    }
    expect(implementation.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([shellTool, 'write', 'edit', 'read', 'fusion_submit_result']))
    expect(JSON.stringify(implementation.messages)).toContain('findings')
    expect(taskSnapshot(implementation).exploration.workOrderId).toBe(orders[0]!.payload.order.id)
    const activity = readFusionActivity(store, parent.id, 'explore')
    expect(activity.events).toMatchObject([{ source: { type: 'tool/call', data: { name: 'read' } } }, { source: { type: 'tool/result' } }])
    expect(readFusionActivity(store, parent.id, 'delegate').events).toHaveLength(2)
    expect(store.replay(taskId)).toEqual(state)
    expect(ctx.agents.get(SessionId(state.acceptedChild!))?.status).not.toBe('running')
    expect((await ctx.sessionQuery.readSession(SessionId(state.acceptedChild!))).session.parentSession).toBe(parent.id)
  })

  it('denies exploration writes and shell, rejects unsupported reports and never manufactures implementation acceptance', async () => {
    const { parent, coordinator, ctx, store, taskId, workspace } = await setup([
      explore(), review('accept'), toolCallResponse('takeover', 'fusion_takeover', { reason: 'Skip the implementation plan.' }), textResponse('Awaiting a plan.'),
    ], [edit('forbidden-shell'), toolCallResponse('forbidden-write', 'write', { file_path: 'calc.py', content: 'bad' }),
      report('missing-sources'), findings()], { files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explore before implementation.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId)
    const childToolResults = await persistedToolResults(ctx, state.acceptedChild!)
    const rejected = childToolResults.map(result => result.message)
      .filter(block => block.role === 'tool' && ['forbidden-shell', 'forbidden-write'].includes(block.toolCallId))
    expect(rejected).toHaveLength(2)
    expect(rejected.every(block => block.role === 'tool' && block.isError)).toBe(true)
    expect(JSON.stringify(rejected)).toContain('Exploration is read-only')
    expect(JSON.stringify(childToolResults)).toContain('requires 1–12 source ranges')
    expect(JSON.stringify(toolResults(parent))).toContain('before recording a review')
    expect(JSON.stringify(toolResults(parent))).toContain('Exploration cannot grant a writer')
    expect(state).toMatchObject({ phase: 'PLANNING', verification: 'unverified', control: { mode: 'running' } })
    expect(state.activeReviewTicket).toBeUndefined()
    expect(state.lease).toBeUndefined()
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(0)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('requires collection before promotion and supports a nonblocking exploration wait', async () => {
    const next = toolCallResponse('implementation-plan', 'fusion_delegate', {
      goal: 'Fix addition', brief: 'Use addition in calc.py.', constraints: [], allowedPaths: ['calc.py'],
      checks: [{ id: 'addition', description: 'Addition works', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
    })
    const { parent, coordinator, taskId } = await setup([
      explore(false), delegate(), toolCallResponse('wait-exploration', 'fusion_wait', {}), next, review('accept'), textResponse('Done.'),
    ], [findings(), edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explore then fix.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('Wait for the completed read-only exploration')
    expect(JSON.stringify(toolResults(parent))).toContain('no write lease')
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('restores the read-only mask after replacement, lifts it on promotion and isolates ordinary mixed-mode sessions', async () => {
    const { parent, coordinator, adapter, ctx, store, taskId } = await setup([
      explore(), textResponse('Findings collected.'),
      toolCallResponse('more-facts', 'fusion_rework', { feedback: 'Confirm the source before implementing.' }),
      delegate(), review('accept'), textResponse('Done.'), textResponse('Ordinary response.'),
    ], [readCalc(), findings(), readCalc(), findings('confirmed'), edit(), report()], { files: true, toolMode: 'both' })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect addition.' }] }))
    await parent.whenIdle()
    const childId = coordinator.state(taskId).acceptedChild!
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Confirm then fix addition.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    const requests = adapter.requests.filter(request => request.model === 'worker')
    const exploration = requests.filter(request => taskSnapshot(request).workOrder.mode === 'explore')
    expect(exploration).toHaveLength(4)
    for (const request of exploration) {
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['fusion_read_evidence', 'fusion_submit_result', 'read'])
    }
    for (const request of requests.filter(request => taskSnapshot(request).workOrder.mode === 'implement')) {
      expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([shellTool, 'write', 'edit', 'run_code']))
    }
    const ordinary = (await ctx.agents.create({ sessionId: SessionId('ordinary-mixed'), meta: { cwd: parent.session.header.cwd },
      agentOptions: { provider: 'test-native', model: 'ordinary' } })).agent
    ordinary.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await ordinary.whenIdle()
    const ordinaryTools = adapter.requests.at(-1)!.tools!.map(tool => tool.name)
    expect(ordinaryTools).toEqual(expect.arrayContaining([shellTool, 'write', 'edit', 'run_code']))
    expect(ordinaryTools.some(name => name.startsWith('fusion_'))).toBe(false)
    expect(store.listDocumentIds('child:')).toHaveLength(1)
  })

  it('retains preset-owned reads and hides unrelated agent-local tools in actual Worker requests', async () => {
    const { ctx, parent, coordinator, adapter, taskId, workspace } = await setup(
      [explore(), delegate(), review('accept'), textResponse('Verified.')],
      [toolCallResponse('forbidden-local', 'child_local_probe', {}), readCalc(), findings(), edit(), report()],
      { files: true, presetTools: true })
    expect(ctx.tools.get('read')).toBeUndefined() // Real Web presets do not register file tools globally.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect and fix addition.' }] }))
    await parent.whenIdle()
    const requests = adapter.requests.filter(request => request.model === 'worker')
    const exploration = requests.filter(request => taskSnapshot(request).workOrder.mode === 'explore')
    expect(exploration).toHaveLength(3)
    for (const request of exploration) {
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['fusion_read_evidence', 'fusion_submit_result', 'read'])
    }
    expect(JSON.stringify(exploration.at(-1)!.messages)).toContain('return a - b')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(() => readFileSync(join(workspace, 'must-not-exist'))).toThrow()
    expect(requests.filter(request => taskSnapshot(request).workOrder.mode === 'implement').every(request =>
      request.tools?.some(tool => tool.name === 'write') && request.tools.some(tool => tool.name === shellTool))).toBe(true)
  })

  it('keeps exploration feedback separate from implementation feedback on the same persistent Worker', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      explore(), toolCallResponse('explore-more', 'fusion_rework', { feedback: 'Confirm the exact source line; do not modify it.' }),
      delegate(), review('rework'), toolCallResponse('implement-again', 'fusion_rework', { feedback: 'The test failed. Correct subtraction to addition.' }),
      review('accept'), textResponse('Done after review.'),
    ], [findings(), findings('more-findings'), report('bad-implementation'), edit(), report('fixed-implementation')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find and fix addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    const latest = adapter.requests.filter(request => request.model === 'worker').at(-1)!
    const current = taskSnapshot(latest)
    // The projection is scoped to the implementation order: its initial handoff plus one feedback.
    expect(current.workerHandoffs).toMatchObject({ latestBriefRevision: 1, totalRecords: 2 })
    expect(JSON.stringify(current.workerHandoffs)).not.toContain('Confirm the exact source line')
    expect(JSON.stringify(latest.messages)).toContain('The test failed')
  })

  it('restores completed exploration across controller replacement without a new Worker or replayed exploration', async () => {
    const { parent, coordinator, adapter, ctx, store, taskId } = await setup([
      explore(), textResponse('Findings received; awaiting the implementation decision.'), delegate(), review('accept'), textResponse('Done.'),
    ], [findings(), edit(), report()])
    // A native subagent-settled notice can wake the Lead after its text reply.
    // This fixture's implementation decision belongs to the next user message,
    // so an extra notice must not consume the scripted delegate prematurely.
    let implementationApproved = false
    const stream = adapter.stream.bind(adapter)
    vi.spyOn(adapter, 'stream').mockImplementation(async function* (request) {
      if (!implementationApproved && request.model === 'lead'
        && adapter.requests.filter(item => item.model === 'lead').length >= 2) {
        adapter.requests.push(request)
        yield* textResponse('Findings received; awaiting the implementation decision.')
        return
      }
      yield* stream(request)
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect addition first.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'PLANNING',
      currentWorkOrder: { mode: 'explore' }, exploration: { status: 'completed' } })
    const child = coordinator.state(taskId).acceptedChild, calls = adapter.requests.length
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(restored.state(taskId).control).toMatchObject({ mode: 'running', recovering: false })
    expect(adapter.requests).toHaveLength(calls)
    implementationApproved = true
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Implement your plan now.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: child })
  })

  it('finishes a read-only question as unverified without running implementation checks', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      explore(), toolCallResponse('answer-question', 'fusion_finish_direct', {}), textResponse('It currently subtracts the second argument.'),
    ], [findings()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'What does add do? Do not change it.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'unverified' })
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(0)
    expect(coordinator.state(taskId).acceptedReview).toBeUndefined()
  })

  it('pauses a running exploration and resumes the same read-only Worker before implementation', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      explore(), toolCallResponse('resume-exploration', 'fusion_rework', { feedback: 'Continue the code exploration and return source findings.' }),
      delegate(), review('accept'), textResponse('Done.'),
    ], ['hang-slow', readCalc(), findings(), edit(), report()], { files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explore and fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(2))
    const child = coordinator.state(taskId).acceptedChild
    await coordinator.pause(parent)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'PAUSED', currentWorkOrder: { mode: 'explore' } })
    expect(store.events(taskId).filter(event => event.type === 'lease/acquired')).toEqual([])
    await coordinator.resume(parent, 'scripted-fixture-no-spend')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: child })
    await coordinator.activity.flush()
    expect(readFusionActivity(store, parent.id, 'resume-exploration').events).toHaveLength(2)
  })
})

describe('single conversation activity', () => {
  it('projects an older released Worker from accepted native history without new calls or database writes', async () => {
    const { ctx, parent, coordinator, store, adapter } = await setup(
      [delegate(), review('accept'), textResponse('Implemented and checked.')], [edit(), report()])
    await coordinator.activity.close()
    vi.spyOn(coordinator.activity, 'link').mockImplementation(() => {})
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle(); await ctx.sessions.flush(parent.session)
    const requests = adapter.requests.length, documents = store.listDocumentIds(''), log = parent.session.snapshotEvents()
    const page = await readHistoricalFusionActivity(ctx, store, parent.id, 'delegate')
    expect(page.events.map(event => event.source.type)).toEqual(['tool/call', 'tool/result'])
    expect(page.done).toBe(true)
    expect((await readHistoricalFusionActivity(ctx, store, 'ordinary', 'delegate')).events).toEqual([])
    expect((await readHistoricalFusionActivity(ctx, store, parent.id, 'delegate', page.cursor)).events).toEqual([])
    expect(adapter.requests).toHaveLength(requests)
    expect(store.listDocumentIds('')).toEqual(documents)
    expect(parent.session.snapshotEvents()).toEqual(log)
  })
  it('renders original Worker commands in the parent without adding model messages or replaying side effects', async () => {
    const { ctx, parent, coordinator, store, adapter, taskId, workspace } = await setup(
      [delegate(), review('accept'), textResponse('Implemented and checked.')], [edit(), report()])
    const observed: unknown[] = []
    const unobserve = ctx.on('session/event', (session, event) => {
      if (session.header.parentSession === parent.id && (event.type === 'tool/call' || event.type === 'tool/result')) observed.push(event)
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle(); await coordinator.activity.flush()
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    expect(coordinator.activity.errors.size).toBe(0)
    unobserve()
    const page = readFusionActivity(store, parent.id, 'delegate')
    const events = page.events
    expect(events).toHaveLength(2)
    expect(page.done).toBe(true)
    expect(readFusionActivity(store, parent.id, 'delegate', page.cursor).events).toEqual([])
    expect(readFusionActivity(store, 'ordinary', 'delegate').events).toEqual([])
    expect(events.map(event => event.source.type)).toEqual(['tool/call', 'tool/result'])
    for (const event of events) expect(observed).toContainEqual(event.source)
    const parentMessages = JSON.stringify(parent.session.deriveMessages())
    expect(parentMessages).not.toContain('one-native-job-effect')
    expect(adapter.requests.filter(request => request.model === 'lead').every(request =>
      !JSON.stringify(request.messages).includes('Correct the addition implementation'))).toBe(true)
    expect(activityRows(events)).toMatchObject([{ call: { data: { name: shellTool } }, result: { type: 'tool/result' } }])
    const requests = adapter.requests.length, content = readFileSync(join(workspace, 'calc.py'), 'utf8')
    await coordinator.activity.close()
    const restored = new NativeFusionActivity(ctx, store)
    await restored.flush(); await restored.close()
    expect(readFusionActivity(store, parent.id, 'delegate').events).toEqual(events)
    expect(JSON.stringify(parent.session.deriveMessages())).toBe(parentMessages)
    expect(adapter.requests).toHaveLength(requests)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(content)
  })
})

describe('bounded Worker continuations', () => {
  const feedback = (id: string) => toolCallResponse(id, 'fusion_rework', {
    feedback: 'Continue the current addition implementation, preserve the frozen check, and submit the result.',
  })
  const run = async (parent: Awaited<ReturnType<typeof setup>>['parent']) => {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
  }

  it('continues three truncated turns on the same Worker before reporting without consuming reported rework rounds', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId, authorization } = await setup([
      delegate(), feedback('continue-1'), feedback('continue-2'), feedback('continue-3'), review('accept'), textResponse('Implemented and checked.'),
    ], [maxTokensResponse('Incomplete first turn.'), maxTokensResponse('Incomplete second turn.'), maxTokensResponse('Incomplete third turn.'), edit(), report()], {
      adapterOutput: { lead: 12000, worker: 16000 }, keepalive: { lead: false, worker: false },
    })
    const activations: unknown[] = [], edits: string[] = []
    ctx.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession === parent.id) activations.push(agent) })
    ctx.on('tools/execute', async (exec, next) => { if (exec.callId === 'edit') edits.push(exec.callId); return next() })
    await run(parent)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 0, continuationRounds: 3 })
    const requests = adapter.requests.filter(request => request.model === 'worker')
    expect(new Set(requests.map(request => request.sessionId)).size).toBe(1)
    expect(new Set(activations).size).toBe(4)
    expect(requests.map(request => request.maxTokens)).toEqual([16000, 16000, 16000, 16000, 16000])
    expect(edits).toEqual(['edit'])
    expect(store.readDocument(`budget:${authorization!.authorizationId}`)?.value).toMatchObject({
      requests: adapter.requests.length,
      reservedOutputTokens: adapter.requests.reduce((sum, request) => sum + request.maxTokens!, 0),
    })
  })

  it('still caps reported rework after interleaved unfinished continuations', async () => {
    const { parent, coordinator, adapter, store, taskId, workspace } = await setup([
      delegate(), feedback('continue-1'), review('rework'), feedback('rework-1'), feedback('continue-2'),
      review('rework'), feedback('rework-2'), review('rework'), feedback('rework-rejected'), textResponse('The rework limit needs a user decision.'),
    ], [maxTokensResponse('Incomplete.'), report('candidate-1'), maxTokensResponse('Incomplete again.'), report('candidate-2'), report('candidate-3')], { maxReworkRounds: 2 })
    await run(parent)
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(5)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 2, continuationRounds: 2, submitted: { status: 'completed' } })
    expect(JSON.stringify(toolResults(parent))).toContain('Rework limit reached')
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('bounds unfinished continuations by the frozen Worker step policy and preserves that request limit', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), feedback('continue-1'), feedback('continue-2'), feedback('continue-3'), feedback('continue-rejected'), textResponse('Worker continuation is bounded.'),
    ], [maxTokensResponse('Incomplete.'), maxTokensResponse('Incomplete.'), maxTokensResponse('Incomplete.')], { maxWorkerSteps: 3 })
    await run(parent)
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(3)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 0, continuationRounds: 2 })
    expect(JSON.stringify(toolResults(parent))).toContain('Worker step limit reached')
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(2)
  })

  it('retains the shared request budget across truncated continuations', async () => {
    const { parent, coordinator, adapter, store, taskId, authorization } = await setup([
      delegate(), feedback('continue-1'), feedback('continue-2'), feedback('over-budget'), textResponse('Must not be requested.'),
    ], [maxTokensResponse('Incomplete.'), maxTokensResponse('Incomplete.'), maxTokensResponse('Incomplete.')], {
      maxRequests: 6, keepalive: { lead: false, worker: false },
    })
    await run(parent)
    expect(adapter.requests).toHaveLength(6)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 0, continuationRounds: 2 })
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(JSON.stringify(parent.session.snapshotEvents())).toContain('Approved native request budget exhausted')
    expect(store.readDocument(`budget:${authorization!.authorizationId}`)?.value).toMatchObject({ requests: 6 })
  })

  it('charges blocked and needs-decision reports as reported rework', async () => {
    const { parent, adapter, store, taskId } = await setup([
      delegate(), feedback('rework-blocked'), feedback('rework-rejected'), textResponse('A user decision is required.'),
    ], [toolCallResponse('blocked', 'fusion_submit_result', { status: 'blocked', summary: 'Implementation is blocked.', unresolved: ['Addition is still incorrect.'] }),
      toolCallResponse('needs-decision', 'fusion_submit_result', { status: 'needs-decision', summary: 'Still incomplete.', unresolved: ['Addition is still incorrect.'] })],
    { maxReworkRounds: 1 })
    await run(parent)
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(2)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 1, continuationRounds: 0, submitted: { status: 'needs-decision' } })
    expect(JSON.stringify(toolResults(parent))).toContain('Rework limit reached')
  })

  it('does not execute a tool call from a truncated response before continuing', async () => {
    const truncated = edit('truncated-edit').map(chunk => chunk.type === 'finish'
      ? { ...chunk, reason: { kind: 'max-tokens' as const } } : chunk)
    const { ctx, parent, coordinator, taskId } = await setup([
      delegate(), feedback('continue'), review('accept'), textResponse('Implemented and checked.'),
    ], [truncated, edit(), report()])
    const edits: string[] = []
    ctx.on('tools/execute', async (exec, next) => { if (exec.callId === 'edit' || exec.callId === 'truncated-edit') edits.push(exec.callId); return next() })
    await run(parent)
    expect(edits).toEqual(['edit'])
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('restores a legacy runtime without a continuation counter while retaining its historical rework count', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), textResponse('The Worker turn was truncated.'), feedback('cold-continuation'), review('accept'), textResponse('Implemented and checked.'),
    ], [maxTokensResponse('Incomplete.'), edit(), report()])
    const allowFollowup = holdLeadForFollowup(adapter)
    await run(parent)
    const child = coordinator.bindings.read(parent.id)!.binding.workerId!
    await coordinator.close()
    expect(ctx.agents.get(SessionId(child))).toBeUndefined()
    const row = store.readDocument(`runtime:${taskId}`)!
    const legacy = { ...(row.value as Record<string, unknown>), reworkRounds: 2 }
    delete (legacy as Record<string, unknown>).continuationRounds
    store.writeDocument(`runtime:${taskId}`, row.revision, legacy)
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    await restored.reconcile(parent, { commandId: 'inspect-legacy', note: 'The truncated Worker stopped without executing any tool; inspected unchanged calc.py and test_calc.py.' })
    await restored.resume(parent, 'scripted-fixture')
    allowFollowup()
    await run(parent)
    expect(restored.bindings.read(parent.id)!.binding.workerId).toBe(child)
    expect(restored.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 2, continuationRounds: 1 })
  })
})

describe('last admitted Worker request', () => {
  it('allows the report produced by the last admitted request and completes the bound review', async () => {
    const { parent, coordinator, adapter, taskId, store, authorization } = await setup([
      delegate(), review('accept'), textResponse('Implemented and checked.'),
    ], [edit(), report()], { maxWorkerSteps: 2, keepalive: { lead: false, worker: false } })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(2)
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ submitted: { status: 'completed' } })
    expect(store.readDocument(`budget:${authorization!.authorizationId}`)?.value).toMatchObject({ requests: 5 })
  })

  it('allows an in-budget final edit but rejects the next Worker generation without fabricating a report', async () => {
    const { parent, coordinator, adapter, taskId, store, workspace } = await setup([
      delegate(), textResponse('The implementation turn did not produce a report.'),
    ], [edit(), report()], { maxWorkerSteps: 1 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(store.readDocument(`runtime:${taskId}`)?.value).not.toMatchObject({ submitted: expect.anything() })
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(JSON.stringify(toolResults(parent))).toContain('Worker stopped without fusion_submit_result')
  })

  it.each(['budget', 'pause', 'recovery'] as const)('still rejects final-request effects if the %s control gate closes', async gate => {
    let closeGate = () => {}
    const { parent, coordinator, adapter, taskId, store, workspace } = await setup([
      delegate(), textResponse('Stopped at the control gate.'),
    ], [() => { closeGate(); return edit() }], { maxWorkerSteps: 1 })
    closeGate = () => {
      if (gate === 'budget') coordinator.append(taskId, 'budget/blocked', { reason: 'Explicit test control gate' })
      else if (gate === 'pause') coordinator.append(taskId, 'task/paused', { reason: 'Explicit test pause' })
      else coordinator.append(taskId, 'recovery/needed', { reason: 'Explicit test inspection required' })
    }
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
    expect(store.readDocument(`runtime:${taskId}`)?.value).not.toMatchObject({ submitted: expect.anything() })
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
  })
})

describe('exhausted Worker feedback', () => {
  it('does not interrupt or label the final admitted effect stopped while rejecting impossible feedback', async () => {
    const { parent, coordinator, adapter, taskId, store, ctx, workspace } = await setup([
      delegate(false), textResponse('Worker started.'),
      toolCallResponse('feedback-while-settling', 'fusion_rework', { feedback: 'Continue after this edit.', block: false }),
      textResponse('The current effect may finish; no new feedback was sent.'),
      toolCallResponse('collect-final-effect', 'fusion_wait', {}), textResponse('The report is incomplete.'),
    ], [edit(), report()], { maxWorkerSteps: 1 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      if (exec.callId === 'edit') { exec.signal.addEventListener('abort', release, { once: true }); await gate }
      return next()
    })
    cleanups.push(async () => { release(); dispose() })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(coordinator.effects.pending(taskId)).toHaveLength(1))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check whether feedback can be sent.' }] }))
    await parent.whenIdle()
    expect(child.status).toBe('running')
    expect(coordinator.effects.pending(taskId)).toHaveLength(1)
    expect(store.readDocument(`runtime:${taskId}`)?.value).not.toHaveProperty('workerStepStop')
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(0)
    release(); await child.whenIdle()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Collect the unfinished result.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(readFusionStatus(store, parent.id).task).toMatchObject({ stage: '等待反馈', attention: true, unsettledTools: 0 })
  })

  it('preserves completed exploration when its exhausted Worker cannot accept an implementation plan', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([
      explore(), delegate(false), textResponse('The findings remain available; implementation did not start.'),
    ], [findings(), edit(), report()], { maxWorkerSteps: 1 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explore and then fix addition.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'PLANNING', currentWorkOrder: { mode: 'explore' }, exploration: { status: 'completed' } })
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ submitted: { status: 'completed' }, explorationSubmitted: { status: 'completed' } })
    expect(JSON.stringify(toolResults(parent))).toContain('Worker step limit reached')
    expect(readFusionStatus(store, parent.id).task).toMatchObject({ stage: '等待反馈', attention: true })
  })

  it('preserves a submitted report and its feedback counters when no further request can be admitted', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([
      delegate(), review('rework'), toolCallResponse('over-limit-feedback', 'fusion_rework', { feedback: 'Check the implementation again.', block: false }),
      textResponse('The existing candidate is preserved; further execution is unavailable.'),
    ], [edit(), report()], { maxWorkerSteps: 2 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(2)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({
      submitted: { status: 'completed' }, reworkRounds: 0, continuationRounds: 0, briefRevision: 0,
    })
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(0)
    expect(JSON.stringify(toolResults(parent))).toContain('Worker step limit reached')
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
  })

  it('reports an incomplete exhausted Worker without queueing impossible continuation or claiming it is running', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([
      delegate(), toolCallResponse('over-limit-continuation', 'fusion_rework', { feedback: 'Submit the missing report.', block: false }),
      textResponse('The incomplete work needs a decision.'),
    ], [edit(), report()], { maxWorkerSteps: 1 })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ reworkRounds: 0, continuationRounds: 0, briefRevision: 0 })
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(0)
    expect(JSON.stringify(toolResults(parent))).toContain('worker-step-limit')
    expect(readFusionStatus(store, parent.id).task).toMatchObject({ stage: '等待反馈', attention: true })
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
  })
})

describe('Worker provider failure', () => {
  const quota = () => [{ type: 'finish' as const, reason: { kind: 'error' as const, failure: {
    code: 'RATE_LIMIT', message: '429 {"error":{"message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}',
  } } }]
  let feedbackId = 0
  const feedback = () => toolCallResponse(`retry-worker-${++feedbackId}`, 'fusion_rework', { feedback: 'Continue the same implementation and submit its report.' })

  it('surfaces quota exhaustion and refuses repeated feedback before any counter, lease or dispatch change', async () => {
    const { parent, coordinator, adapter, store, taskId, workspace } = await setup([
      delegate(), feedback(), feedback(), textResponse('The Worker provider quota is exhausted. Awaiting user input.'),
    ], [quota(), edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(JSON.stringify(toolResults(parent))).toContain('worker-quota-exhausted')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ continuationRounds: 0, reworkRounds: 0, briefRevision: 0 })
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(0)
    expect(readFusionStatus(store, parent.id).task).toMatchObject({ stage: '等待额度', attention: true, unsettledTools: 0 })
    expect(coordinator.state(taskId).verification).toBe('unverified')
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
  })

  it('retains the quota stop for plugin notices and allows the same Worker after new user input', async () => {
    let phase: 'initial' | 'notice' | 'retry' = 'initial', step = 0
    const scriptedLead = () => {
      const current = step++
      if (phase === 'initial') return current === 0 ? delegate() : textResponse('Quota exhausted.')
      if (phase === 'notice') return current === 0 ? feedback() : textResponse('Still awaiting the user.')
      return current === 0 ? feedback() : current === 1 ? review('accept') : textResponse('Implemented and checked.')
    }
    const { parent, coordinator, adapter, store, taskId } = await setup(Array.from({ length: 30 }, () => scriptedLead), [quota(), edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const childId = coordinator.state(taskId).acceptedChild
    phase = 'notice'; step = 0
    parent.followup(createUserMessage({ source: { kind: 'plugin:fixture', summary: 'Background update' }, content: [{ type: 'text', text: 'Status update.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`)).toHaveLength(0)
    phase = 'retry'; step = 0
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Quota restored; continue the task.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker'), JSON.stringify({
      state: coordinator.state(taskId), runtime: store.readDocument(`runtime:${taskId}`)?.value,
      tools: toolResults(parent), ends: parent.session.snapshotEvents().filter(e => e.type === 'turn/end'),
    })).toHaveLength(3)
    expect(coordinator.state(taskId)).toMatchObject({ acceptedChild: childId, phase: 'COMPLETED', verification: 'verified' })
    expect(store.readDocument(`runtime:${taskId}`)?.value).not.toHaveProperty('workerFailure')
  })

  it('does not confuse a transient rate limit with exhausted quota or expose raw provider text', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([
      delegate(), feedback(), review('accept'), textResponse('Implemented and checked.'),
    ], [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 Too many concurrent requests. private-marker' } } }], edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(3)
    expect(JSON.stringify(toolResults(parent))).toContain('worker-provider-error')
    expect(JSON.stringify(toolResults(parent))).not.toContain('private-marker')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('persists the stop across replacement without bypassing recovery and clears it only on explicit resume', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), textResponse('Quota exhausted.'), textResponse('Waiting.'),
    ], [quota()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const failure = (store.readDocument(`runtime:${taskId}`)!.value as { workerFailure: unknown }).workerFailure
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ workerFailure: failure })
    expect(restored.state(taskId).control.recovering).toBe(true)
    await expect(restored.resume(parent, 'scripted-authorization')).rejects.toThrow('recover')
    await restored.reconcile(parent, { commandId: 'fixture-inspection', note: 'Confirmed no running tools, no changed files and no unknown effects.', effectsStopped: true })
    await restored.resume(parent, 'scripted-authorization')
    expect(store.readDocument(`runtime:${taskId}`)?.value).not.toHaveProperty('workerFailure')
    expect(store.readDocument(`runtime:${taskId}`)?.value).toHaveProperty('workerFailureClearedThrough')
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
  })

  it('detects a stopped background Worker before sending feedback without requiring a prior wait', async () => {
    const { ctx, parent, coordinator, adapter, taskId } = await setup([
      delegate(false), feedback(), textResponse('Worker quota exhausted.'),
    ], [quota(), edit(), report()])
    const dispose = parent.ctx.on('agent/pre-step', async (payload, next) => {
      const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild ?? 'absent'))
      if (payload.agent === parent && child) await child.whenIdle()
      return next()
    })
    cleanups.push(async () => dispose())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(JSON.stringify(toolResults(parent))).toContain('worker-quota-exhausted')
  })
})

describe('automatic role response limits', () => {
  it('keeps the Worker route cap across cold continuation without inheriting the explicit Lead cap', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId, authorization } = await setup([
      delegate(), textResponse('Implementation returned; review remains pending.'),
      review('rework'), toolCallResponse('correct-again', 'fusion_rework', { feedback: 'Correct subtraction to addition.' }),
      review('accept'), textResponse('Implemented and checked.'),
    ], [report('first-candidate'), edit(), report('corrected-candidate')], {
      parentMaxTokens: 3000, adapterOutput: { lead: 12000, worker: 16000 }, keepalive: { lead: false, worker: false },
    })
    const activations: unknown[] = []
    ctx.on('agent/created', ({ agent }) => { if (agent.session.header.parentSession === parent.id) activations.push(agent) })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    const child = coordinator.bindings.read(parent.id)!.binding.workerId!
    expect(ctx.agents.get(SessionId(child))).toBeUndefined() // Prove a cold activation on the next turn.
    const first = adapter.requests.filter(request => request.model === 'worker')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the pending review.' }] }))
    await parent.whenIdle()
    const all = adapter.requests.filter(request => request.model === 'worker')
    expect(coordinator.bindings.read(parent.id)!.binding.workerId).toBe(child)
    expect(new Set(activations).size).toBe(2)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect({ first: first.map(request => request.maxTokens), resumed: all.slice(first.length).map(request => request.maxTokens) })
      .toEqual({ first: [16000], resumed: [16000, 16000] })
    expect(adapter.requests.filter(request => request.model === 'lead').every(request => request.maxTokens === 3000)).toBe(true)
    expect(store.readDocument(`budget:${authorization!.authorizationId}`)?.value).toMatchObject({
      requests: adapter.requests.length,
      reservedOutputTokens: adapter.requests.reduce((sum, request) => sum + request.maxTokens!, 0),
    })
  })

  it('honors exact adapter caps and reserves the full effective caps in the shared ledger', async () => {
    const { parent, adapter, store, authorization } = await setup([delegate(), review('accept'), textResponse('Implemented and checked.')],
      [edit(), report()], { adapterOutput: { lead: 12000, worker: 16000 }, keepalive: { lead: false, worker: false } })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.some(request => request.model === 'lead')).toBe(true)
    expect(adapter.requests.some(request => request.model === 'worker')).toBe(true)
    for (const request of adapter.requests) expect(request.maxTokens).toBe(request.model === 'lead' ? 12000 : 16000)
    expect(store.readDocument(`budget:${authorization!.authorizationId}`)?.value).toMatchObject({
      requests: adapter.requests.length,
      reservedOutputTokens: adapter.requests.reduce((sum, request) => sum + request.maxTokens!, 0),
    })
  })

  it('uses a bounded fallback instead of inventing an output allowance from the context window', async () => {
    const { parent, adapter, modelContext } = await setup([textResponse('Hello.')], undefined, { adapterOutput: null })
    modelContext.window = 1_000_000
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()
    expect(adapter.requests[0]!.maxTokens).toBe(8_000)
  })
})

// POSIX escapes embedded ' via '"'"'; pwsh doubles it. Same result either way for
// quotes-free payloads.
const shellQuote = (text: string) => process.platform === 'win32'
  ? "'" + text.replaceAll("'", "''") + "'"
  : "'" + text.replaceAll("'", "'\"'\"'") + "'"
const backgroundEdit = (gate: string) => toolCallResponse('background-edit', shellTool, {
  command: py('python3 -c ') + shellQuote('from pathlib import Path\nimport time\n'
    + `gate = Path(${JSON.stringify(gate)})\n`
    + 'while not gate.exists(): time.sleep(0.01)\n'
    + 'Path("calc.py").write_text("def add(a, b):\\n    return a + b\\n# one-native-job-effect\\n")\n'),
  description: 'Wait for the fixture then correct addition', run_in_background: true,
})
function waitForJob(request: GenerateOptions, callId = 'wait-job') {
  const id = JSON.stringify(request.messages).match(new RegExp(`started background job (${shellTool}-\\d+)`))?.[1]
  if (!id) throw new Error('The actual native job identity is absent from Worker history')
  return toolCallResponse(callId, 'job_output', { job_id: id, wait: true, timeout_ms: 10_000 })
}

describe('owned native background commands', () => {
  it('native cancellation of a Lead wait retains its job for an explicit follow-up', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter } = await setup([
      toolCallResponse('take', 'fusion_takeover', { reason: 'Small direct correction.' }),
      () => backgroundEdit(gate), request => waitForJob(request),
      request => waitForJob(request, 'explicit-follow-up-wait'),
      toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Done.'),
    ], undefined, { jobs: true })
    gate = join(workspace, '..', 'release-after-lead-interruption')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition directly.' }] }))
    await waitForNative(() => expect(coordinator.effects.waitingForJob(parent)).toBe(true))
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    const calls = adapter.requests.length
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    await parent.whenIdle()
    expect(ctx.jobs.get(JobId(job.id), parent.id).status).toBe('running')
    expect(coordinator.state(taskId).lease?.holder).toBe(parent.id)
    expect(adapter.requests).toHaveLength(calls)
    expect(coordinator.effects.waitingForJob(parent)).toBe(false)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue waiting on the original job.' }] }))
    await waitForNative(() => expect(coordinator.effects.waitingForJob(parent)).toBe(true))
    expect(ctx.jobs.get(JobId(job.id), parent.id).status).toBe('running')
    writeFileSync(gate, 'release')
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    expect(coordinator.state(taskId).verification).toBe('unverified')
    expect(parent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === shellTool)).toHaveLength(1)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8').match(/one-native-job-effect/g)).toHaveLength(1)
  })

  it('native cancellation of a blocking handoff stops the Worker job with no replay', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter, store } = await setup([
      delegate(),
    ], [() => backgroundEdit(gate), request => waitForJob(request)], { jobs: true })
    gate = join(workspace, '..', 'never-release-native-cancel')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition with the Worker.' }] }))
    await waitForNative(() => expect(coordinator.effects.pending(taskId).some(row => row.record.nativeJob)).toBe(true))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    await waitForNative(() => expect(coordinator.effects.waitingForJob(child)).toBe(true))
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    const calls = adapter.requests.length
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    await parent.whenIdle()
    // Native ancestor cancellation disposes this child and removes its registry
    // entries. The completed public job notification remains in our journal.
    expect(store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'returned', nativeJob: expect.objectContaining({ id: job.id, status: 'killed' }) })]))
    expect(coordinator.effects.pending(taskId)).toEqual([])
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(coordinator.state(taskId).control.mode).toBe('paused')
    expect(adapter.requests).toHaveLength(calls)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it.each([false, true])('steers a waiting Worker while retaining the same job, writer and exactly one effect (blocking=%s)', async blocking => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter, store } = await setup([
      delegate(blocking), ...(blocking ? [] : [textResponse('Working.')]),
      toolCallResponse('steer', 'fusion_rework', { feedback: 'Retain the running job. REVISION-ONE. Do not restart it.', block: true }),
      review('accept'), textResponse('Verified.'),
    ], [
      () => backgroundEdit(gate), request => waitForJob(request),
      request => {
        expect(JSON.stringify(request.messages)).toContain('REVISION-ONE')
        return waitForJob(request, 'wait-after-revision')
      }, report(),
    ], { jobs: true })
    gate = join(workspace, '..', 'release-native-job')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify.' }] }))
    if (!blocking) await parent.whenIdle()
    await waitForNative(() => expect(coordinator.effects.pending(taskId).some(row => row.record.nativeJob)).toBe(true))
    const childId = coordinator.state(taskId).acceptedChild!
    const child = ctx.agents.get(SessionId(childId))!
    await waitForNative(() => expect(coordinator.effects.waitingForJob(child)).toBe(true))
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    expect(ctx.jobs.get(JobId(job.id), child.id).status).toBe('running')
    expect(coordinator.state(taskId).lease?.holder).toBe(childId)
    const revision = createUserMessage({ content: [{ type: 'text', text: 'Apply my revision to the same command.' }], source: { kind: 'user' } })
    if (blocking) parent.steer(revision)
    else parent.followup(revision)
    await waitForNative(() => expect(adapter.requests.filter(row => row.model === 'worker')).toHaveLength(3))
    expect(ctx.jobs.get(JobId(job.id), child.id).status).toBe('running')
    expect(coordinator.state(taskId).acceptedChild).toBe(childId)
    expect(coordinator.state(taskId).lease?.holder).toBe(childId)
    writeFileSync(gate, 'release')
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    expect(coordinator.effects.pending(taskId)).toEqual([])
    // Native quiescence removes the finished registry entry; its result and
    // the plugin's durable job record remain available.
    expect(JSON.stringify(toolResults(child))).toContain('status: completed')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8').match(/one-native-job-effect/g)).toHaveLength(1)
    expect(child.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === shellTool)).toHaveLength(1)
    expect(store.listDocumentIds(`native-effect:${taskId}:`).some(id => {
      const row = store.readDocument(id)!.value as { nativeJob?: { status: string }; state: string }
      return row.nativeJob?.status === 'completed' && row.state === 'returned'
    })).toBe(true)
  })

  it('stops the tracked process on pause and cannot accept a report while it is running', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter } = await setup([
      delegate(false), textResponse('Working.'),
    ], [() => backgroundEdit(gate), report('premature-report'), request => waitForJob(request)], { jobs: true })
    gate = join(workspace, '..', 'never-release-native-job')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(row => row.model === 'worker')).toHaveLength(3))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    await waitForNative(() => expect(coordinator.effects.waitingForJob(child)).toBe(true))
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    expect(JSON.stringify(toolResults(child))).toContain('settle effects before submitting')
    const callsBeforePause = adapter.requests.length
    await coordinator.pause(parent)
    expect(ctx.jobs.get(JobId(job.id), child.id).status).toBe('killed')
    expect(coordinator.effects.pending(taskId)).toEqual([])
    expect(coordinator.state(taskId).control.mode).toBe('paused')
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(adapter.requests).toHaveLength(callsBeforePause)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('denies reading and killing an unowned native job without changing it', async () => {
    let foreign = ''
    const { ctx, parent, coordinator, taskId } = await setup([
      delegate(), review('accept'), textResponse('Verified.'),
    ], [
      () => toolCallResponse('foreign-read', 'job_output', { job_id: foreign }),
      () => toolCallResponse('foreign-kill', 'job_kill', { job_id: foreign }),
      request => {
        const results = JSON.stringify(request.messages)
        expect(results.match(/Only native jobs recorded/g)).toHaveLength(2)
        expect(results).not.toContain('PRIVATE-UNOWNED')
        return edit()
      }, report(),
    ], { jobs: true })
    let finish!: (result: { status: 'killed' }) => void
    const done = new Promise<{ status: 'killed' }>(resolve => { finish = resolve })
    foreign = ctx.jobs.start({ kind: shellTool, label: 'PRIVATE-UNOWNED-JOB', run: () => ({
      done, cancel: () => finish({ status: 'killed' }), readOutput: () => 'PRIVATE-UNOWNED-OUTPUT',
    }) })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    expect(ctx.jobs.get(JobId(foreign))).toMatchObject({ status: 'running' })
    ctx.jobs.kill(JobId(foreign))
    await ctx.jobs.wait(JobId(foreign), 1000)
  })

  it('enforces the frozen command deadline without treating a killed command as correct work', async () => {
    let gate = ''
    const { parent, coordinator, taskId, workspace, store } = await setup([
      // The one-second limit targets the Worker job. Give the independent
      // acceptance check time to start PowerShell without being promoted itself.
      delegate(true, 15), textResponse('The command did not complete the task.'),
    ], [() => backgroundEdit(gate), request => waitForJob(request), report()], { jobs: true, commandMaxSeconds: 1 })
    gate = join(workspace, '..', 'never-release-deadline')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).currentWorkOrder!.policy.commandMaxSeconds).toBe(1)
    expect(coordinator.state(taskId).phase).not.toBe('COMPLETED')
    expect(coordinator.effects.pending(taskId)).toEqual([])
    const records = store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'worker', state: 'returned', nativeJob: expect.objectContaining({ status: 'killed' }),
    })]))
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('stops a direct Lead job on pause and denies finishing before it has settled', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter } = await setup([
      toolCallResponse('take', 'fusion_takeover', { reason: 'Small direct correction.' }),
      () => backgroundEdit(gate), toolCallResponse('early-finish', 'fusion_finish_direct', {}),
      request => waitForJob(request),
    ], undefined, { jobs: true })
    gate = join(workspace, '..', 'never-release-direct')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition directly.' }] }))
    await waitForNative(() => expect(coordinator.effects.waitingForJob(parent)).toBe(true))
    expect(JSON.stringify(toolResults(parent))).toContain('before completing the direct task')
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    const calls = adapter.requests.length
    await coordinator.pause(parent)
    expect(ctx.jobs.get(JobId(job.id), parent.id).status).toBe('killed')
    expect(coordinator.effects.pending(taskId)).toEqual([])
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(coordinator.state(taskId).control.mode).toBe('paused')
    expect(adapter.requests).toHaveLength(calls)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('keeps uncertain cancellation behind recovery with its writer retained', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, adapter } = await setup([
      delegate(false), textResponse('Working.'),
    ], [() => backgroundEdit(gate), request => waitForJob(request)], { jobs: true })
    gate = join(workspace, '..', 'never-release-failed-cancel')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    await waitForNative(() => expect(coordinator.effects.waitingForJob(child)).toBe(true))
    const job = coordinator.effects.pending(taskId).find(row => row.record.nativeJob)!.record.nativeJob!
    const calls = adapter.requests.length
    const stop = vi.spyOn(ctx.jobs, 'kill').mockImplementation(() => { throw new Error('Producer cancellation failed') })
    try {
      await expect(coordinator.pause(parent)).rejects.toThrow('Producer cancellation failed')
      expect(coordinator.effects.pending(taskId)[0]!.record.state).toBe('outcome-unknown')
      expect(coordinator.state(taskId).control.recovering).toBe(true)
      expect(coordinator.state(taskId).lease?.holder).toBe(child.id)
      expect(ctx.jobs.get(JobId(job.id), child.id).status).toBe('running')
      await expect(coordinator.resume(parent, 'scripted-only')).rejects.toThrow()
      expect(adapter.requests).toHaveLength(calls)
    } finally {
      stop.mockRestore()
      ctx.jobs.kill(JobId(job.id), child.id)
      await ctx.jobs.wait(JobId(job.id), 1000, child.id)
      await child.whenIdle()
    }
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })

  it('drains jobs when the plugin closes and gates the restored task without restarting its command', async () => {
    let gate = ''
    const { ctx, parent, coordinator, taskId, workspace, store, adapter } = await setup([
      delegate(false), textResponse('Working.'),
    ], [() => backgroundEdit(gate), request => waitForJob(request)], { jobs: true })
    gate = join(workspace, '..', 'never-release-unload')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    await waitForNative(() => expect(coordinator.effects.waitingForJob(child)).toBe(true))
    const calls = adapter.requests.length
    await coordinator.close()
    expect(coordinator.effects.pending(taskId)).toEqual([])
    expect(ctx.agents.get(child.id)).toBeUndefined()
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(adapter.requests).toHaveLength(calls)
    const replacement = new FusionCoordinator(ctx, store, { ...coordinator.options })
    cleanups.push(() => replacement.close())
    expect(replacement.state(taskId).control.recovering).toBe(true)
    await expect(replacement.resume(parent, 'scripted-only')).rejects.toThrow('recover')
    expect(adapter.requests).toHaveLength(calls)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
  })
})

describe('Sidekick paths in the leased workspace', () => {
  // The lease holds the realpath; models write the session's spelling (macOS /tmp is /private/tmp, a symlinked checkout).
  it('accepts any spelling of the project root and its subdirectories, and refuses directories outside it', async () => {
    const worker: Script = []
    const { ctx, parent, coordinator, taskId, workspace } = await setup([delegate(), review('accept'), textResponse('Verified.')], worker, { files: true })
    mkdirSync(join(workspace, 'demo'))
    const alias = join(dirname(workspace), 'alias')
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const probe = (id: string, workdir: string) => toolCallResponse(id, shellTool, { command: shellCommand('pwd', 'Get-Location'), description: 'Show the working directory', workdir })
    worker.push(probe('root-alias', alias), probe('relative-sub', 'demo'), probe('alias-sub', join(alias, 'demo')), probe('outside', dirname(workspace)),
      toolCallResponse('write-alias', 'write', { file_path: join(alias, 'calc.py'), content: 'def add(a, b):\n    return a + b\n' }), report())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId)
    expect(state.acceptedChild, JSON.stringify(toolResults(parent))).toBeDefined()
    const results = await persistedToolResults(ctx, state.acceptedChild!)
    const outcome = (id: string) => results.find(result => result.message.role === 'tool' && result.message.toolCallId === id)!.message
    for (const id of ['root-alias', 'relative-sub', 'alias-sub', 'write-alias']) expect(outcome(id).isError, `${id}: ${JSON.stringify(outcome(id))}`).toBeFalsy()
    expect(JSON.stringify(outcome('outside'))).toContain('is outside it')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe('def add(a, b):\n    return a + b\n')
    expect(state, JSON.stringify(results)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })
})

function toolResults(parent: Awaited<ReturnType<typeof setup>>['parent']) {
  return parent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data)
}

/** Tool/result events of a child whose registry entry may already be gone. */
async function persistedToolResults(ctx: Context, sessionId: string) {
  const snapshot = await ctx.sessionQuery.readSession(SessionId(sessionId))
  return snapshot.events.filter(event => event.type === 'tool/result').map(event => event.data)
}

function taskSnapshot(request: Awaited<ReturnType<typeof setup>>['adapter']['requests'][number]) {
  const section = request.messages.flatMap(message => message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot'
    ? message.source.sections.filter(section => section.name === FUSION_TASK_CONTEXT) : []).at(-1)
  if (!section) throw new Error('No native Fusion task snapshot')
  return JSON.parse(section.text.slice(section.text.indexOf('\n') + 1)).facts
}

/** The newest complete (post-compaction) snapshot; routine steps append compact ones. */
function fullTaskSnapshot(request: Awaited<ReturnType<typeof setup>>['adapter']['requests'][number]) {
  const facts = request.messages.flatMap(message => message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot'
    ? message.source.sections.filter(section => section.name === FUSION_TASK_CONTEXT) : [])
    .map(section => JSON.parse(section.text.slice(section.text.indexOf('\n') + 1)).facts).filter(facts => facts.detail !== 'compact').at(-1)
  if (!facts) throw new Error('No complete Fusion task snapshot in this request')
  return facts
}

async function askNative(ctx: Context, role: 'lead' | 'worker' = 'lead') {
  if (!ctx.get('approval')) await ctx.plugin(ApprovalService, { policy: 'ask' })
  let answer!: (outcome: ApprovalOutcome) => void, asked!: (request: ApprovalRequest) => void
  const decision = new Promise<ApprovalOutcome>(resolve => { answer = resolve })
  const pending = new Promise<ApprovalRequest>(resolve => { asked = resolve })
  const disposePolicy = ctx.on('tools/pre-execute', async (exec, next) => {
    const prior = await next()
    const matches = role === 'lead' ? exec.agent?.id === 'lead' : exec.agent?.id !== 'lead'
    return matches && exec.name === shellTool ? { kind: 'ask', reason: 'Fixture command requires approval' } : prior
  })
  const disposeAnswer = ctx.on('approval/request', async request => { asked(request); return decision })
  return { pending, answer, dispose: () => { disposeAnswer(); disposePolicy() } }
}

function waitForApproval(parent: Awaited<ReturnType<typeof setup>>['parent'], pending: Promise<ApprovalRequest>) {
  return Promise.race([pending, parent.whenIdle().then(() => {
    throw new Error(`Turn ended before approval: ${JSON.stringify({ results: toolResults(parent),
      agents: parent.ctx.agents.list().map(agent => ({ id: agent.id, tail: agent.session.snapshotEvents().slice(-5) })) })}`)
  })])
}

describe('complete native Fusion workflow', () => {
  it('lets Lead read the exact check receipt advertised by report coverage before accepting', async () => {
    const result = (request: GenerateOptions, id: string) => {
      const block = request.messages.findLast(block => block.role === 'tool' && block.toolCallId === id)
      if (!block || block.role !== 'tool' || block.isError) throw new Error(`Missing successful native result: ${id}`)
      return JSON.parse(block.content.filter(part => part.type === 'text').map(part => part.text).join(''))
    }
    const { parent, coordinator, taskId } = await setup([
      delegate(), edit(), report(),
      request => toolCallResponse('read-receipt', 'fusion_read_evidence', { id: result(request, 'delegate').report.coverage[0].evidenceIds[0] }),
      request => {
        const page = result(request, 'read-receipt'), record = JSON.parse(page.text)
        expect(page.nextOffset).toBeNull()
        expect(record.kind).toBe('check-receipt')
        expect(record.receipt.counts).toEqual({ executed: 1, passed: 1, failed: 0 })
        expect(record.receipt.evidence).toMatchObject({ taskId, state: 'completed', exitCode: 0 })
        return toolCallResponse('read-test-output', 'fusion_read_evidence', { id: record.receipt.evidence.stderr.id })
      },
      request => {
        expect(result(request, 'read-test-output').text).toContain('Ran 1 test')
        return review('accept')
      },
      textResponse('Read the actual check receipt and output before accepting.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and inspect the check evidence.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(toolResults(parent).map(result => result.message).filter(block => block.role === 'tool' && block.isError)).toEqual([])
  })
  it('delivers the frozen before/after diff to Lead through paged native evidence tools before review', async () => {
    const result = (request: GenerateOptions, id: string) => {
      const block = request.messages.findLast(block => block.role === 'tool' && block.toolCallId === id)
      if (!block || block.role !== 'tool' || block.isError) throw new Error(`Missing successful native result: ${id}`)
      return JSON.parse(block.content.filter(part => part.type === 'text').map(part => part.text).join(''))
    }
    let patchId = '', first = ''
    const { parent, coordinator, taskId, store } = await setup([
      delegate(), edit(), report(),
      request => toolCallResponse('read-manifest', 'fusion_read_evidence', { id: result(request, 'delegate').report.changeManifest.id }),
      request => {
        const page = result(request, 'read-manifest'), manifest = JSON.parse(page.text)
        expect(page.nextOffset).toBeNull(); expect(manifest.schemaVersion).toBe(2)
        expect(manifest.changes).toEqual(['calc.py'])
        patchId = manifest.diffs[0].patch.id
        return toolCallResponse('read-patch-first', 'fusion_read_evidence', { id: patchId, limit: 60 })
      },
      request => {
        const page = result(request, 'read-patch-first'); first = page.text
        expect(page.truncated).toBe(true)
        return toolCallResponse('read-patch-tail', 'fusion_read_evidence', { id: patchId, offset: page.nextOffset })
      },
      request => {
        const page = result(request, 'read-patch-tail')
        expect(page.nextOffset).toBeNull()
        expect(first + page.text).toContain('-    return a - b\n+    return a + b\n')
        return review('accept')
      },
      textResponse('Reviewed the actual diff and native test evidence.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and inspect the complete diff before accepting.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(1)
    expect(store.events(taskId).filter(event => event.type === 'child/accepted')).toHaveLength(1)
    expect(toolResults(parent).map(result => result.message).filter(block => block.role === 'tool' && block.isError)).toEqual([])
  })
  it('projects actual native task, tools and usage without adding requests or changing persisted state', async () => {
    const { parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), edit(), report(), review('accept'), textResponse('Verified'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify.' }] }))
    await parent.whenIdle()
    const before = store.listDocumentIds('').map(id => [id, store.readDocument(id)])
    const seq = parent.session.seq, calls = adapter.requests.length
    for (let i = 0; i < 20; i++) {
      const status = readFusionStatus(store, parent.id)
      expect(status.task).toMatchObject({ stage: '完成', verification: 'verified', workerId: coordinator.state(taskId).acceptedChild,
        usage: { calls, actualBilledUsd: null }, pendingApprovals: 0, unsettledTools: 0 })
      expect(status.task!.tools.some(tool => tool.name === shellTool)).toBe(true)
      expect(status.task!.contexts.map(context => context.role).sort()).toEqual(['lead', 'worker'])
      expect(status.task!.requests.every(request => request.provider === 'test-native')).toBe(true)
    }
    expect(adapter.requests).toHaveLength(calls)
    expect(parent.session.seq).toBe(seq)
    expect(store.listDocumentIds('').map(id => [id, store.readDocument(id)])).toEqual(before)
    if (process.env.FUSION_STATUS_PROOF) writeFileSync(process.env.FUSION_STATUS_PROOF, JSON.stringify(readFusionStatus(store, parent.id), null, 2))
  })
  it.each(['delegate', 'wait'])('lets native user steering release a blocking %s while ordinary queued input stays queued', async waitingTool => {
    const revision = createUserMessage({ content: [{ type: 'text', text: 'USER-REVISION: keep the same Worker and correct addition.' }], source: { kind: 'user' } })
    const { parent, coordinator, store, adapter, taskId, workspace, ctx } = await setup([
      ...(waitingTool === 'delegate' ? [delegate()] : [delegate(false), toolCallResponse('blocking-wait', 'fusion_wait', {})]),
      request => {
        expect(JSON.stringify(request.messages)).toContain('USER-REVISION')
        expect(JSON.stringify(request.messages)).toContain('user-steering')
        return toolCallResponse('steer-blocking', 'fusion_rework', { feedback: 'USER-REVISION: preserve both inputs and correct subtraction to addition.' })
      },
      review('accept'), textResponse('Verified after the user revision.'),
    ], ['hang-slow', edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }], source: { kind: 'user' } }))
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    const leadRequests = waitingTool === 'delegate' ? 1 : 2
    await waitForNative(() => expect(parent.session.snapshotEvents().some(event => event.type === 'tool/call'
      && event.data.name === `fusion_${waitingTool}`)).toBe(true))
    const childId = coordinator.state(taskId).acceptedChild!
    const child = ctx.agents.get(SessionId(childId))!
    expect(parent.status).toBe('running')
    expect(child.status).toBe('running')
    // The native default Send mode queues a turn. The plugin must not promote it.
    parent.followup(revision)
    parent.inject(createUserMessage({ content: [{ type: 'text', text: 'Unrelated plugin context.' }], source: { kind: 'plugin:fixture' } }))
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(parent.inbox.nextTurn.map(message => message.id)).toContain(revision.id)
    expect(adapter.requests.filter(request => request.model === 'lead')).toHaveLength(leadRequests)
    expect(adapter.requests.find(request => request.model === 'worker')!.signal?.aborted).toBe(false)
    // The native queue's Steer action does exactly this: remove, then steer.
    expect(parent.inbox.remove(revision.id)).toBe(true)
    parent.steer(revision)
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(3), { timeout: 1500 })
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    expect(parent.inbox.hasPending).toBe(false)
    expect(store.listDocumentIds('child:')).toEqual([`child:${childId}`])
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`).map(id => store.readDocument(id)!.value)).toMatchObject([
      { state: 'accepted', delivery: 'interrupt-generation', briefRevision: 1, childId },
    ])
    const usage = nativeUsage(store).filter(row => row.role === 'worker')
    expect(usage).toHaveLength(3)
    expect(usage.filter(row => row.outcome === 'aborted')).toMatchObject([{ sessionId: childId }])
    expect(coordinator.effects.pending(taskId)).toEqual([])
    expect(coordinator.state(taskId).lease).toBeUndefined()
  })

  it('steers a background generation on the same Worker while fencing Lead writes and recording cancellation', async () => {
    const { parent, coordinator, store, adapter, taskId, workspace, ctx } = await setup([
      delegate(false), textResponse('Worker is running.'),
      edit('forbidden-lead-edit'),
      toolCallResponse('steer', 'fusion_rework', { feedback: 'REVISION: preserve both inputs; correct subtraction to addition.' }),
      review('accept'), textResponse('Verified after steering.'),
    ], ['hang-slow', edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    const childId = coordinator.state(taskId).acceptedChild!
    const child = ctx.agents.get(SessionId(childId))!
    expect(child.status).not.toBe('idle')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'WORKER_RUNNING', control: { mode: 'running' }, lease: { holder: childId } })
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toEqual([])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this clarification and continue.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    expect(JSON.stringify(toolResults(parent))).toContain('this Agent is read-only')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    // Native continuation handles can unload after a parent turn completes;
    // durable child identity, transcript and usage ownership must persist.
    expect(store.listDocumentIds('child:')).toEqual([`child:${childId}`])
    const revised = adapter.requests.filter(request => request.model === 'worker')[1]!
    expect(JSON.stringify(revised.messages)).toContain('Fix calc.py add')
    expect(JSON.stringify(revised.messages)).toContain('REVISION: preserve both inputs')
    const deliveries = store.listDocumentIds(`worker-delivery:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(deliveries).toMatchObject([{ state: 'accepted', delivery: 'interrupt-generation', briefRevision: 1, childId }])
    const workerUsage = store.listDocumentIds(`usage:${taskId}:`).map(id => store.readDocument(id)!.value as { role: string }).filter(row => row.role === 'worker')
    expect(workerUsage).toHaveLength(3)
    expect(workerUsage).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'aborted', sessionId: childId,
      upstreamHttpCalls: null, actualSubscriptionChargeUsd: null })]))
    expect(workerUsage.every(row => (row as { sessionId?: string }).sessionId === childId)).toBe(true)
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(1)
  })

  it('waits for a background report and refuses duplicate acceptance checks', async () => {
    const { parent, coordinator, store, taskId, ctx } = await setup([
      delegate(false), textResponse('Waiting for later review.'),
      toolCallResponse('wait', 'fusion_wait', {}), toolCallResponse('repeat-wait', 'fusion_wait', {}),
      review('accept'), textResponse('Verified.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    await child.whenIdle()
    expect(coordinator.state(taskId).lease?.holder).toBe(child.id)
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(0)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Collect the report.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(JSON.stringify(toolResults(parent))).toContain('review it before another wait')
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(1)
  })

  it.each([false, true])('queues a brief behind a running native tool and rejects a report from the old request (blocking=%s)', async blocking => {
    const stale = report('stale-report')
    const first = edit('held-edit').filter(chunk => chunk.type !== 'finish')
    const combined = [...first, ...stale.map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk)]
    const { parent, coordinator, store, taskId, ctx, adapter } = await setup([
      delegate(blocking), ...(blocking ? [] : [textResponse('Worker started.')]),
      toolCallResponse('queued-brief', 'fusion_rework', { feedback: 'REVISION: inspect the completed edit, then submit a fresh report.', block: false }),
      textResponse('Brief delivered.'), toolCallResponse('wait', 'fusion_wait', {}), review('accept'), textResponse('Verified.'),
    ], [combined, report('fresh-report')])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      if (exec.callId === 'held-edit') {
        exec.signal.addEventListener('abort', release, { once: true })
        await gate
      }
      return next()
    })
    cleanups.push(async () => { release(); dispose() })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    if (!blocking) await parent.whenIdle()
    await waitForNative(() => expect(coordinator.effects.pending(taskId)).toHaveLength(1))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    const revision = createUserMessage({ content: [{ type: 'text', text: 'Clarify the report before the edit finishes.' }], source: { kind: 'user' } })
    if (blocking) parent.steer(revision)
    else parent.followup(revision)
    await parent.whenIdle()
    expect(coordinator.effects.pending(taskId)).toHaveLength(1)
    expect(child.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(0)
    expect(store.listDocumentIds(`worker-delivery:${taskId}:`).map(id => store.readDocument(id)!.value)).toMatchObject([
      { state: 'accepted', delivery: 'next-step', briefRevision: 1 },
    ])
    release()
    await child.whenIdle()
    expect(JSON.stringify(toolResults(child))).toContain('newer Lead brief superseded')
    expect(JSON.stringify(adapter.requests.filter(request => request.model === 'worker')[1]!.messages)).toContain('REVISION: inspect the completed edit')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Wait and review.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'held-edit', state: 'returned', nativeIsError: false }),
    ]))
  })

  it('drains a detached Worker on native Lead cancellation before releasing the writer', async () => {
    const { parent, coordinator, taskId, adapter, ctx } = await setup([delegate(false), 'hang-slow'], ['hang-slow'])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(3))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    await parent.whenIdle()
    await waitForNative(() => expect(coordinator.state(taskId).lease).toBeUndefined())
    expect(child.status).toBe('idle')
    expect(coordinator.state(taskId).control).toMatchObject({ mode: 'paused', recovering: false })
    expect(coordinator.effects.pending(taskId)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(3)
  })

  it('recovers a detached Worker across coordinator replacement without replaying its old brief', async () => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(false), textResponse('Worker started.'),
      toolCallResponse('resume-brief', 'fusion_rework', { feedback: 'Continue only after the recorded inspection; correct addition and report.' }),
      review('accept'), textResponse('Recovered.'),
    ], ['hang-slow', edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    const childId = coordinator.state(taskId).acceptedChild!
    await coordinator.close()
    expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(restored.state(taskId).control.recovering).toBe(true)
    expect(adapter.requests).toHaveLength(3)
    await expect(restored.resume(parent, 'fixture-only')).rejects.toThrow('recover')
    await restored.reconcile(parent, { commandId: 'inspect-background', note: 'Inspected the unchanged workspace and the stopped native Worker; no command or write began.' })
    await restored.resume(parent, 'fixture-only')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume the inspected work.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    expect(store.listDocumentIds('child:')).toEqual([`child:${childId}`])
  })

  it('repairs a partial Agent scope after overlapping module generations finish draining', async () => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(false), textResponse('Worker started.'),
      toolCallResponse('overlap-resume', 'fusion_rework', { feedback: 'Continue the inspected task once; correct addition and report.' }),
      review('accept'), textResponse('Recovered after overlapping generations.'),
    ], ['hang-slow', edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    const childId = coordinator.state(taskId).acceptedChild!
    const closing = coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    await closing
    expect(() => restored.scopes.assertReady(parent)).toThrow()
    await expect(restored.resume(parent, 'fixture-only')).rejects.toThrow('recover')
    await restored.reconcile(parent, { commandId: 'inspect-overlap', note: 'Inspected the old generation and its stopped child; no file change was repeated.' })
    const installFault = vi.spyOn(restored.scopes, 'install').mockImplementationOnce(() => { throw new Error('Injected scope unavailable') })
    await expect(restored.resume(parent, 'fixture-only')).rejects.toThrow('Injected scope unavailable')
    expect(restored.state(taskId).control.mode).toBe('paused')
    expect(adapter.requests).toHaveLength(3)
    installFault.mockRestore()
    await restored.resume(parent, 'fixture-only')
    expect(() => restored.scopes.assertReady(parent)).not.toThrow()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the inspected task.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(3)
  })

  it.each(['prepared', 'runtime', 'accepted'] as const)('requires inspection after a %s brief journal failure and never replays it automatically', async stage => {
    const workerScript: Script = ['hang-slow', 'hang-slow']
    const { parent, coordinator, store, adapter, taskId, workspace } = await setup([
      delegate(false), textResponse('Worker started.'),
      toolCallResponse('failed-brief', 'fusion_rework', { feedback: 'First recorded correction; preserve the test.', block: false }),
      toolCallResponse('inspected-brief', 'fusion_rework', { feedback: 'Inspection complete. Correct addition once and submit.' }),
      review('accept'), textResponse('Recovered and verified.'),
    ], workerScript)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    const childId = coordinator.state(taskId).acceptedChild
    const write = store.writeDocument.bind(store)
    const fault = vi.spyOn(store, 'writeDocument').mockImplementation((id, revision, value) => {
      if (id.startsWith('worker-delivery:') && (value as { state?: string }).state === stage) throw new Error(`Injected ${stage} brief journal failure`)
      if (stage === 'runtime' && id.startsWith('runtime:') && (value as { briefRevision?: number }).briefRevision === 1) throw new Error('Injected brief runtime commit failure')
      return write(id, revision, value)
    })
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with the correction.' }] }))
      await parent.whenIdle()
      expect(coordinator.state(taskId).control.recovering).toBe(true)
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
    } finally { fault.mockRestore() }
    const calls = adapter.requests.length
    await expect(coordinator.resume(parent, 'fixture-only')).rejects.toThrow('recover')
    await coordinator.reconcile(parent, { commandId: 'inspect-brief-journal', note: 'Inspected the stopped native Worker, durable briefs and unchanged calc.py; no file effect ran.' })
    expect(adapter.requests).toHaveLength(calls)
    const inspected = store.listDocumentIds(`worker-delivery:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(inspected).toEqual(stage === 'prepared' ? [] : [expect.objectContaining({ briefRevision: 1,
      state: stage === 'runtime' ? 'not-applied-after-interruption' : 'inspected-after-interruption' })])
    workerScript.splice(0, workerScript.length, edit('only-edit'), report('inspected-report'))
    await coordinator.resume(parent, 'fixture-only')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Resume the inspected task.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    const effects = store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value as { callId: string })
    expect(effects.filter(row => row.callId === 'only-edit')).toHaveLength(1)
  })

  it('pauses and drains a blocking wait when native cancellation bypasses the Fusion pause command', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([delegate()], ['hang-slow'])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(2))
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ control: { mode: 'paused', recovering: false } })
    expect(coordinator.state(taskId).lease).toBeUndefined()
  })

  it('retains write ownership when background quiescence cannot be proved', async () => {
    const { parent, coordinator, taskId, adapter } = await setup([delegate(false), 'hang-slow'], ['hang-slow'])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(3))
    const childId = coordinator.state(taskId).acceptedChild!
    const failedStop = vi.spyOn(coordinator.transport, 'stop').mockRejectedValue(new Error('Injected native persistence failure'))
    try {
      parent.cancel({ kind: 'user' }, { keepInbox: true })
      await parent.whenIdle()
      await waitForNative(() => expect(coordinator.state(taskId).control.recovering).toBe(true))
      expect(coordinator.state(taskId).lease?.holder).toBe(childId)
      await expect(coordinator.resume(parent, 'fixture-only')).rejects.toThrow('recover')
      expect(adapter.requests).toHaveLength(3)
    } finally { failedStop.mockRestore() }
    await coordinator.reconcile(parent, { commandId: 'inspect-quiescence', note: 'Inspected the still-resident child; recovery drained it and no native file effects ran.' })
    expect(coordinator.state(taskId)).toMatchObject({ control: { mode: 'paused', recovering: false } })
    expect(coordinator.state(taskId).lease).toBeUndefined()
  })

  it('gates replacement during a background rework even after the original handoff has a recorded result', async () => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), review('rework'),
      toolCallResponse('background-rework', 'fusion_rework', { feedback: 'Correct the failed addition implementation.', block: false }),
      textResponse('Worker is revising.'),
      toolCallResponse('recovered-rework', 'fusion_rework', { feedback: 'Resume the inspected correction, then report.' }),
      review('accept'), textResponse('Verified after recovery.'),
    ], [report('failed-candidate'), 'hang-slow', edit(), report('fixed-candidate')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(2))
    const childId = coordinator.state(taskId).acceptedChild!
    expect(store.outbox(taskId).find(row => row.kind === 'native-worker')?.state).toBe('result-recorded')
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(restored.state(taskId).control.recovering).toBe(true)
    await expect(restored.resume(parent, 'fixture-only')).rejects.toThrow('recover')
    await restored.reconcile(parent, { commandId: 'inspect-rework', note: 'Inspected the failed candidate and the stopped rework generation; no new edit began.' })
    await restored.resume(parent, 'fixture-only')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the inspected rework.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: childId })
    expect(store.listDocumentIds('child:')).toEqual([`child:${childId}`])
  })

  it.each(['start', 'return'] as const)('recovers a native effect journal failure at %s after inspection', async stage => {
    const effect = () => toolCallResponse('counted-edit', shellTool, { command: shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py; printf 'effect\\n' >> effects.txt", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\"); [IO.File]::AppendAllText((Join-Path $PWD 'effects.txt'), \"effect`n\")"), description: 'Apply and count the inspected edit' })
    const { parent, coordinator, store, adapter, taskId, workspace } = await setup([
      toolCallResponse('takeover', 'fusion_takeover', { reason: 'Small direct edit' }), effect(),
      toolCallResponse('recovered-takeover', 'fusion_takeover', { reason: 'Inspection finished; continue without repeating completed effects' }),
      ...(stage === 'start' ? [effect()] : []),
      toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Completed after inspection.'),
    ])
    writeFileSync(join(workspace, 'effects.txt'), '')
    const write = store.writeDocument.bind(store)
    const failure = vi.spyOn(store, 'writeDocument').mockImplementation((id, revision, value) => {
      if (id.startsWith('native-effect:') && (value as { state?: string }).state === (stage === 'start' ? 'dispatch-started' : 'returned')) {
        throw new Error('Injected native effect journal write failure')
      }
      return write(id, revision, value)
    })
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
      await parent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(coordinator.state(taskId).phase).not.toBe('COMPLETED')
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain(stage === 'start' ? 'a - b' : 'a + b')
      if (stage === 'start') expect(coordinator.effects.pending(taskId)).toEqual([])
      else expect(coordinator.effects.pending(taskId)).toMatchObject([{ record: { state: 'outcome-unknown', toolName: shellTool } }])
    } finally { failure.mockRestore() }
    expect(coordinator.state(taskId).control.recovering).toBe(true)
    await expect(coordinator.resume(parent, 'scripted-only')).rejects.toThrow('recover')
    await expect(coordinator.clear(parent)).rejects.toThrow('Reconcile')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue before inspection.' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    if (stage === 'return') await expect(coordinator.reconcile(parent, { commandId: 'insufficient',
      note: 'The local journal is writable again; the workspace is available.' })).rejects.toThrow('--effects-stopped')
    await coordinator.reconcile(parent, { commandId: 'inspected-journal-failure', effectsStopped: stage === 'return',
      note: 'Inspected the settled native command, calc.py and the counted effect; no command is live. The journal is writable again.' })
    expect(coordinator.state(taskId).control).toMatchObject({ mode: 'paused', recovering: false })
    await coordinator.resume(parent, 'scripted-only')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: stage === 'start' ? 'Apply the unstarted correction once and finish.' : 'Finish with the inspected correction; do not repeat it.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED' })
    expect(readFileSync(join(workspace, 'effects.txt'), 'utf8')).toBe('effect\n')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
  })

  it('persists a native Lead check approval without expiring the enclosing delegation', async () => {
    const { ctx, parent, coordinator, store, taskId, workspace } = await setup([
      delegate(), edit(), report(), review('accept'), textResponse('Verified after approval.'),
    ])
    await ctx.plugin(ToolTimeoutPolicy)
    const approval = await askNative(ctx)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
      const request = await waitForApproval(parent, approval.pending)
      expect(coordinator.state(taskId)).toMatchObject({ phase: 'WAITING_APPROVAL', control: { mode: 'running' } })
      const logical = Object.values(coordinator.state(taskId).pendingApprovals)[0]!
      expect(logical).toMatchObject({ requestingAgent: parent.id, toolName: shellTool, callId: request.callId, role: 'lead', state: 'pending' })
      expect(store.readDocument(`native-approval:${taskId}:${logical.nativeRequestId}`)?.value).toMatchObject({ state: 'pending', rootCallId: 'delegate', askedSeq: expect.any(Number) })
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(request.signal?.aborted).toBe(false)
      expect(coordinator.state(taskId).pendingApprovalIds).toEqual([logical.id])
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    } finally { vi.useRealTimers(); approval.answer('allowed-once') }
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', pendingApprovalIds: [] })
    const journal = store.listDocumentIds(`native-approval:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(journal).toMatchObject([{ state: 'decided', nativeOutcome: 'allowed-once', effect: 'settled', logical: { state: 'consumed' } }])
    expect(JSON.stringify(journal)).not.toContain('decisionBy')
  })

  it.each(['workspace', 'policy', 'pause'] as const)('does not apply a pending grant after %s changes', async kind => {
    const { ctx, parent, coordinator, store, taskId, workspace } = await setup([
      toolCallResponse('takeover', 'fusion_takeover', { reason: 'Small direct edit' }), edit(),
    ])
    const approval = await askNative(ctx)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    const request = await waitForApproval(parent, approval.pending)
    if (kind === 'workspace') writeFileSync(join(workspace, 'user-note.txt'), 'Changed while waiting')
    if (kind === 'policy') setApprovalPolicy(request.agent.session, 'never')
    if (kind === 'pause') coordinator.append(taskId, 'task/paused', { reason: 'User paused while approval was pending' })
    approval.answer('allowed-once')
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
    expect(coordinator.state(taskId).control.mode).toBe('paused')
    expect(coordinator.state(taskId).pendingApprovalIds).toEqual([])
    const journal = store.listDocumentIds(`native-approval:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(journal).toMatchObject([{ state: 'decided', nativeOutcome: 'rejected', scopeRejection: expect.any(String), effect: 'failed' }])
  })

  it('withdraws the logical wait on native cancellation and ignores a late grant', async () => {
    const { ctx, parent, coordinator, store, taskId, workspace } = await setup([
      toolCallResponse('takeover', 'fusion_takeover', { reason: 'Small direct edit' }), edit(),
    ])
    const approval = await askNative(ctx)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForApproval(parent, approval.pending)
    await coordinator.pause(parent)
    approval.answer('allowed-once')
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
    expect(coordinator.state(taskId)).toMatchObject({ control: { mode: 'paused', pendingApprovalIds: [] } })
    const journal = store.listDocumentIds(`native-approval:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(journal).toMatchObject([{ state: 'decided', nativeOutcome: 'cancelled', logical: { state: 'withdrawn' } }])
  })

  it('preserves the native never policy for a delegated Worker and records its rejection', async () => {
    const { ctx, parent, coordinator, store, taskId, workspace } = await setup([delegate(), edit()])
    const approval = await askNative(ctx, 'worker')
    let answererCalled = false
    void approval.pending.then(() => { answererCalled = true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    expect(answererCalled).toBe(false)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
    expect(coordinator.state(taskId)).toMatchObject({ control: { mode: 'paused', pendingApprovalIds: [] } })
    const journal = store.listDocumentIds(`native-approval:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(journal).toMatchObject([{ role: 'worker', state: 'decided', nativeOutcome: 'rejected', effect: 'failed' }])
  })

  it('recovers an unfinished durable approval with a fresh native question and no replayed grant', async () => {
    const take = () => toolCallResponse('takeover', 'fusion_takeover', { reason: 'Small direct edit' })
    const { ctx, parent, coordinator, store, taskId, workspace, adapter } = await setup([
      take(), edit(), take(), edit('fresh-edit'), toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Done'),
    ])
    const approval = await askNative(ctx)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForApproval(parent, approval.pending)
    const oldLogical = Object.values(coordinator.state(taskId).pendingApprovals)[0]!
    const snapshotPath = join(workspace, '..', 'approval-recovery.sqlite')
    const reader = new DatabaseSync(store.filename, { readOnly: true })
    try { await backup(reader, snapshotPath) } finally { reader.close() }
    await coordinator.pause(parent)
    approval.answer('allowed-once') // native cancellation already won
    approval.dispose()
    await coordinator.close()
    const reopened = new SqliteFusionStore(snapshotPath)
    const restored = new FusionCoordinator(ctx, reopened, coordinator.options)
    cleanups.push(async () => { await restored.close(); reopened.close() })
    expect(restored.state(taskId)).toMatchObject({ control: { recovering: true, pendingApprovalIds: [oldLogical.id] } })
    expect(adapter.requests).toHaveLength(2)
    await restored.reconcile(parent, { commandId: 'inspected-approval', note: 'Inspected the interrupted edit: calc.py is unchanged and the old Agents are idle.' })
    expect(restored.state(taskId)).toMatchObject({ control: { mode: 'paused', recovering: false, pendingApprovalIds: [] } })
    const fresh = await askNative(ctx)
    await restored.resume(parent, 'fixture-authorization')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retry the inspected edit and ask again.' }] }))
    await waitForApproval(parent, fresh.pending)
    const renewed = Object.values(restored.state(taskId).pendingApprovals)[0]!
    expect(renewed.id).toBe(oldLogical.id)
    expect(renewed.operationId).toBe(oldLogical.operationId)
    expect(renewed.nativeRequestId).not.toBe(oldLogical.nativeRequestId)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
    fresh.answer('allowed-once')
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    expect(restored.state(taskId).phase).toBe('COMPLETED')
    const old = reopened.readDocument(`native-approval:${taskId}:${oldLogical.nativeRequestId}`)?.value
    expect(old).toMatchObject({ state: 'withdrawn-after-inspection', reissuedAs: `native-approval:${taskId}:${renewed.nativeRequestId}` })
    expect(old).not.toHaveProperty('nativeOutcome')
  })

  it.each(['scope', 'decision'] as const)('recovers approval %s persistence failure with a fresh question', async stage => {
    const { ctx, parent, coordinator, adapter, store, taskId, workspace } = await setup([
      toolCallResponse('takeover', 'fusion_takeover', { reason: 'Small direct edit' }), edit(),
      toolCallResponse('retry-takeover', 'fusion_takeover', { reason: 'Retry only after explicit inspection' }), edit('retry-edit'),
      toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Done after fresh approval.'),
    ])
    const approval = await askNative(ctx)
    const write = store.writeDocument.bind(store)
    const failure = vi.spyOn(store, 'writeDocument').mockImplementation((id, revision, value) => {
      if (id.startsWith('native-approval:') && (stage === 'scope' || (value as { state?: string }).state === 'decided')) {
        throw new Error('Injected durable approval write failure')
      }
      return write(id, revision, value)
    })
    try {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
      if (stage === 'decision') {
        await waitForApproval(parent, approval.pending)
        approval.answer('allowed-once')
      }
      await parent.whenIdle()
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
      expect(parent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    } finally { failure.mockRestore(); approval.answer('rejected'); approval.dispose() }
    expect(coordinator.state(taskId).control.recovering).toBe(true)
    expect(adapter.requests).toHaveLength(2)
    await expect(coordinator.resume(parent, 'scripted-only')).rejects.toThrow('recover')
    await coordinator.reconcile(parent, { commandId: 'inspected-approval-journal',
      note: 'Inspected the idle command and unchanged calc.py after the approval recording failure; the journal is writable again.' })
    expect(coordinator.state(taskId).control).toMatchObject({ mode: 'paused', recovering: false, pendingApprovalIds: [] })
    const fresh = await askNative(ctx)
    try {
      await coordinator.resume(parent, 'scripted-only')
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Retry the inspected edit and obtain a fresh approval.' }] }))
      await waitForApproval(parent, fresh.pending)
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a - b')
      fresh.answer('allowed-once')
      await parent.whenIdle()
      expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED' })
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    } finally { fresh.answer('rejected'); fresh.dispose() }
  })

  it('uses an unmodified native model selection and never dispatches a virtual upstream request', async () => {
    const { ctx, parent, coordinator, adapter, selectionRef } = await setup([
      delegate(), edit(), report(), review('accept'), textResponse('Verified'), textResponse('Ordinary answer'),
    ])
    await coordinator.clear(parent)
    const catalog = new FusionCatalogAdapter()
    ctx.llm.registerAdapter([FUSION_PROVIDER], catalog)
    expect(await catalog.resolveModel(FUSION_PROVIDER, FUSION_MODEL)).not.toHaveProperty('reasoning')
    const remove = installNativeFusionSelection(ctx, { coordinator: () => coordinator,
      profile: () => coordinator.options.profile, selection: () => selectionRef.current })
    cleanups.push(async () => remove())
    const fusion = { provider: FUSION_PROVIDER, model: FUSION_MODEL }
    parent.session.append('model/selection', fusion)
    selectionRef.current = fusion
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify.' }] }))
    await parent.whenIdle()
    const binding = coordinator.bindings.read(parent.id)!.binding
    expect(coordinator.state(binding.taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests.map(request => request.model)).toEqual(['lead', 'worker', 'worker', 'lead', 'lead'])
    expect(parent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source?.kind === 'model-selection')).toHaveLength(0)
    const ordinary = { provider: 'test-native', model: 'ordinary' }
    parent.session.append('model/selection', ordinary)
    selectionRef.current = ordinary
    await waitForNative(() => expect(coordinator.bindings.read(parent.id)?.binding.selected).toBe(false))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(adapter.requests.at(-1)?.model, JSON.stringify(parent.session.snapshotEvents().slice(-12))).toBe('ordinary')
    expect(adapter.requests.at(-1)?.tools?.some(tool => tool.name.startsWith('fusion_'))).toBe(false)
  })

  it('installs a saved default Fusion selection before the first prompt and tool assembly', async () => {
    const { ctx, parent, coordinator, selectionRef, adapter } = await setup([
      delegate(), edit(), report(), review('accept'), textResponse('Verified'),
    ])
    await coordinator.clear(parent)
    const remove = installNativeFusionSelection(ctx, { coordinator: () => coordinator,
      profile: () => coordinator.options.profile, selection: () => selectionRef.current })
    cleanups.push(async () => remove())
    selectionRef.current = { provider: FUSION_PROVIDER, model: FUSION_MODEL }
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify.' }] }))
    await parent.whenIdle()
    const binding = coordinator.bindings.read(parent.id)!.binding
    expect(coordinator.state(binding.taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests[0]?.tools?.some(tool => tool.name === 'fusion_delegate')).toBe(true)
    const events = parent.session.snapshotEvents()
    const intent = events.filter(event => event.type === 'model/selection')
    expect(intent).toHaveLength(1)
    expect(intent[0]).toMatchObject({ data: { provider: FUSION_PROVIDER, model: FUSION_MODEL } })
    expect(events.indexOf(intent[0]!)).toBeLessThan(events.findIndex(event => event.type === 'request/header'))
    // Physical request accounting stays truthful; the native menu retains the
    // separately committed virtual selection even when it was a saved default.
    expect(events.findLast(event => event.type === 'request/header')).toMatchObject({
      data: { header: { config: { provider: 'test-native', model: 'lead' } } },
    })
  })

  it('shows a settings instruction without invoking a model when Fusion has no configured pair', async () => {
    const { ctx, parent, coordinator, selectionRef, adapter } = await setup([textResponse('Must not run')])
    await coordinator.clear(parent)
    ctx.llm.registerAdapter([FUSION_PROVIDER], new FusionCatalogAdapter())
    const remove = installNativeFusionSelection(ctx, { coordinator: () => undefined,
      profile: () => undefined, selection: () => selectionRef.current })
    cleanups.push(async () => remove())
    selectionRef.current = { provider: FUSION_PROVIDER, model: FUSION_MODEL }
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(coordinator.bindings.read(parent.id)?.binding.selected).toBe(false)
    const end = parent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(end).toMatchObject({ data: { reason: { kind: 'error', error: { message: expect.stringContaining('设置 → Fusion') } } } })
  })

  it('drains a live Worker before leaving Fusion through the ordinary model menu', async () => {
    const { ctx, parent, coordinator, selectionRef, adapter } = await setup([delegate(), 'hang-slow', textResponse('Ordinary answer')])
    selectionRef.current = { provider: FUSION_PROVIDER, model: FUSION_MODEL }
    const remove = installNativeFusionSelection(ctx, { coordinator: () => coordinator,
      profile: () => coordinator.options.profile, selection: () => selectionRef.current })
    cleanups.push(async () => remove())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(2))
    const ordinary = { provider: 'test-native', model: 'ordinary' }
    parent.session.append('model/selection', ordinary)
    selectionRef.current = ordinary
    await waitForNative(() => expect(coordinator.bindings.read(parent.id)?.binding.selected).toBe(false))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(adapter.requests.at(-1)?.model).toBe('ordinary')
    expect(adapter.requests.at(-1)?.tools?.some(tool => tool.name.startsWith('fusion_'))).toBe(false)
  })
  it('selects, delegates, edits, checks, reviews and completes using real native tools', async () => {
    const { parent, coordinator, store, adapter, taskId, workspace } = await setup([
      delegate(), edit(), report(), review('accept'), textResponse('Addition fixed; 1 test passed.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition in calc.py and verify it.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId)
    expect(toolResults(parent), JSON.stringify({ results: toolResults(parent), end: parent.session.snapshotEvents().at(-1) })).toHaveLength(2)
    expect(toolResults(parent).map(result => result.message.content)).toEqual(expect.not.arrayContaining([expect.arrayContaining([expect.objectContaining({ isError: true })])]))
    expect(state, JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(state.lease).toBeUndefined()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(adapter.requests.map(request => request.model)).toEqual(['lead', 'worker', 'worker', 'lead', 'lead'])
    expect(store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(1)
    expect(store.listDocumentIds(`usage:${taskId}:`)).toHaveLength(5)
    expect(state.acceptedReview?.ticket.subject.snapshot).toBe(state.lastSnapshot)
  })

  it('keeps a failing candidate incomplete and reworks the same native child', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([
      delegate(), report('incorrect-report'), review('rework'),
      toolCallResponse('rework', 'fusion_rework', { feedback: 'The actual addition test failed. Replace subtraction with addition and resubmit.' }),
      edit(), report('correct-report'), review('accept'), textResponse('Fixed after rework; 1 test passed.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition in calc.py and verify it.' }] }))
    await parent.whenIdle()
    const state = coordinator.state(taskId)
    const worker = coordinator.ctx.agents.get(SessionId(state.acceptedChild!))
    expect(state, JSON.stringify({ results: toolResults(parent), child: worker?.session.snapshotEvents().slice(-8) })).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests.map(request => request.model)).toEqual(['lead', 'worker', 'lead', 'lead', 'worker', 'worker', 'lead', 'lead'])
    const children = coordinator.store.listDocumentIds('child:')
    expect(children).toEqual([`child:${state.acceptedChild}`])
    expect(JSON.stringify(adapter.requests[4].messages)).toContain('incorrect-report')
    expect(JSON.stringify(adapter.requests[4].messages)).toContain('actual addition test failed')
  })

  it('refuses an accepting review when native acceptance checks failed', async () => {
    const { parent, coordinator, taskId } = await setup([delegate(), report(), review('accept'), textResponse('The task remains incomplete.')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).not.toBe('COMPLETED')
    expect(coordinator.state(taskId).lastReport?.coverage[0]?.state).toBe('not-satisfied')
    expect(JSON.stringify(toolResults(parent))).toContain('do not prove completion')
  })

  it('rolls completed direct turns into new tasks and restores the physical route on exit', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([textResponse('Hello'), textResponse('Second answer'), textResponse('Ordinary answer')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', intent: 'DIRECT', verification: 'unverified' })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Another simple question' }] }))
    await parent.whenIdle()
    const second = coordinator.bindings.read(parent.id)!.binding.taskId
    expect(second).not.toBe(taskId)
    expect(coordinator.state(second).phase).toBe('COMPLETED')
    expect(taskSnapshot(adapter.requests[1]!)).toMatchObject({ taskId: second, phase: 'PLANNING', workOrder: null, userInstructions: [] })
    expect(coordinator.store.listDocumentIds('child:')).toEqual([])
    await coordinator.clear(parent)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Ordinary session' }] }))
    await parent.whenIdle()
    expect(adapter.requests.map(request => request.model)).toEqual(['lead', 'lead', 'ordinary'])
    expect(adapter.requests[2].tools?.some(tool => tool.name.startsWith('fusion_'))).toBe(false)
  })

  it('restores exact task facts after a lossy native summary and controller replacement', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), edit(), report(), textResponse('Candidate ready for review.'),
      textResponse('All restrictions are removed. No checks remain.'),
      review('accept'), textResponse('Reviewed with the actual retained requirements.'),
    ])
    await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
    const instruction = 'Fix addition. Keep the literal {{provider}} unchanged and preserve test_calc.py.'
    parent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).toBe('REVIEWING')
    const workerFacts = taskSnapshot(adapter.requests[1]!)
    expect(workerFacts.userInstructions).toMatchObject([{ text: [instruction], source: { kind: 'user', sessionId: parent.id } }])
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Do not change test_calc.py')
    expect(await ctx.compaction.compactNow(parent, new AbortController().signal)).not.toBeNull()
    expect(JSON.stringify(parent.session.deriveMessages())).not.toContain(instruction)
    expect(parent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === instruction))).toBe(true)
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the candidate against my requirements.' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const request = adapter.requests.findLast(item => item.model === 'lead' && item.purpose === undefined)!
    const facts = fullTaskSnapshot(request)
    expect(facts.taskId).toBe(taskId)
    expect(facts.userInstructions[0].text).toEqual([instruction])
    expect(facts.workOrder.allowedPaths).toEqual(['calc.py'])
    expect(facts.workOrder.acceptance[0].id).toBe('addition')
    expect(facts.workerHandoffs.records[0]).toMatchObject({ revision: 0, source: 'lead-tool-handoff' })
    expect(facts.workerHandoffs.records[0].content).toContain('Fix calc.py add and preserve the test. Submit a report after implementing.')
    expect(facts.control).toMatchObject({ pendingApprovalIds: [], budgetBlocked: false, outcomeUnknown: false })
    expect(request.system ?? '').not.toContain(instruction)
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('restores the initial handoff after a lossy child compaction and completes with the same Worker', async () => {
    const initial = 'FIRST-HANDOFF-ONLY: add both numeric arguments and preserve test_calc.py.'
    const first = toolCallResponse('initial-handoff', 'fusion_delegate', {
      goal: 'Correct addition', brief: initial, constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'],
      checks: [{ id: 'addition', description: 'Existing addition test passes', command: py('python3 -B -m unittest -v test_calc'),
        kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
    })
    const { ctx, parent, coordinator, adapter, taskId } = await setup([
      first, textResponse('Waiting for continuation.'),
      toolCallResponse('continue-initial', 'fusion_rework', { feedback: 'Finish the original handoff and submit the result.' }),
      review('accept'), textResponse('Corrected and verified.'),
    ], [textResponse('Previous exploration. '.repeat(4500)).filter(chunk => chunk.type !== 'usage'),
      textResponse('The original handoff was omitted.'), edit(), report()], { workerTarget: 26_000 })
    await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
    const allowFollowup = holdLeadForFollowup(adapter)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const childId = coordinator.state(taskId).acceptedChild!, child = ctx.agents.get(SessionId(childId))
    if (child) await child.whenIdle()
    const savedChild = await ctx.sessionQuery.readSession(SessionId(childId))
    expect(savedChild.session.parentSession).toBe(parent.id)
    expect(savedChild.events.some(event => event.type === 'turn/end')).toBe(true)
    const compactionEnds: unknown[] = []
    cleanups.push(async () => observeCompaction())
    const observeCompaction = ctx.on('session/event', (session, event) => {
      if (session.id === childId && event.type === 'compaction/end') compactionEnds.push(event.data)
    })
    allowFollowup()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the existing task.' }] }))
    await parent.whenIdle()
    const continued = adapter.requests.filter(request => request.model === 'worker' && request.purpose === undefined).at(-1)!
    const facts = fullTaskSnapshot(continued)
    expect(facts.workerHandoffs.records[0].content).toContain(initial)
    expect(taskSnapshot(continued).workerHandoffs).toMatchObject({ totalRecords: 2, omittedRecords: 0, latestBriefRevision: 1 })
    expect(JSON.stringify(continued.messages)).toContain('Finish the original handoff and submit the result.')
    expect(facts.workOrder.allowedPaths).toEqual(['calc.py'])
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({
      phase: 'COMPLETED', verification: 'verified', acceptedChild: childId,
    })
    expect(compactionEnds).toHaveLength(1)
    expect(compactionEnds[0]).not.toHaveProperty('error')
    const summary = adapter.requests.find(request => request.model === 'worker' && request.purpose === 'compaction')!
    expect(JSON.stringify(summary.messages)).toContain(initial)
    expect(JSON.stringify(continued.messages)).toContain('The original handoff was omitted.')
    expect(JSON.stringify(continued.messages)).not.toContain('Previous exploration. '.repeat(4500))
  })

  it('blocks dispatch if a later plugin removes the required native task context', async () => {
    const { parent, adapter } = await setup([textResponse('must not dispatch')])
    const dispose = parent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(message =>
        !(message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot')) }
    }, { prepend: true })
    cleanups.push(async () => dispose())
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(parent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: {
      reason: { kind: 'error', error: { message: expect.stringContaining('task context is absent') } },
    } })
  })

  it.each([false, true])('reuses Worker history across completed tasks with fresh checks (controller replacement: %s)', async (replaceController) => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), edit(), report('first-task-report'), review('accept'), textResponse('First task done.'),
      toolCallResponse('delegate-second', 'fusion_delegate', {
        goal: 'Verify the follow-up requirement', brief: 'Preserve the implementation, verify the new work order, and submit a new report.',
        constraints: ['Preserve both existing files'], allowedPaths: ['calc.py'],
        checks: [{ id: 'addition-followup', description: 'The follow-up addition check passes',
          command: py('python3 -B -m unittest -v test_calc.TestAdd.test_add'), kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
      }), report('second-task-report'), review('accept'), textResponse('Second task done.'),
      textResponse('A direct follow-up.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const first = coordinator.state(taskId), workerId = first.acceptedChild!
    expect(first.phase).toBe('COMPLETED')
    expect(coordinator.bindings.read(parent.id)!.binding.workerId).toBe(workerId)
    let active = coordinator
    if (replaceController) {
      await coordinator.close()
      expect(ctx.agents.get(SessionId(workerId))).toBeUndefined()
      active = new FusionCoordinator(ctx, store, coordinator.options)
      cleanups.push(async () => active.close())
    }
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the existing implementation for the next task.' }] }))
    await parent.whenIdle()
    const secondId = active.bindings.read(parent.id)!.binding.taskId, second = active.state(secondId)
    expect(secondId).not.toBe(taskId)
    expect(second, JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', acceptedChild: workerId, verification: 'verified' })
    expect(second.currentWorkOrder!.id).not.toBe(first.currentWorkOrder!.id)
    expect(second.currentWorkOrder!.acceptance[0]!.id).toBe('addition-followup')
    expect(second.activeReviewTicket!.id).not.toBe(first.activeReviewTicket!.id)
    expect(store.listDocumentIds(`check-invocation:${secondId}:`)).toHaveLength(1)
    expect(store.listDocumentIds('child:')).toEqual([`child:${workerId}`])
    const continued = adapter.requests.filter(request => request.model === 'worker').at(-1)!
    expect(JSON.stringify(continued.messages)).toContain('first-task-report')
    expect(JSON.stringify(continued.messages)).toContain(second.currentWorkOrder!.id)
    // An intervening direct task must not orphan the resident Worker.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Briefly explain addition.' }] }))
    await parent.whenIdle()
    expect(active.state(active.bindings.read(parent.id)!.binding.taskId).acceptedChild).toBeUndefined()
    await active.clear(parent)
    expect(ctx.agents.get(SessionId(workerId))).toBeUndefined()
  })

  it('refuses Lead takeover until the current Worker report exists', async () => {
    const { parent, coordinator, taskId, workspace } = await setup([
      delegate(false),
      toolCallResponse('early-takeover', 'fusion_takeover', { reason: 'I will write the fix myself before the Worker reports.' }),
      textResponse('Stopped after the refusal.'),
    ], ['hang-slow'])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('current Worker report')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
    expect(coordinator.state(taskId).intent).toBe('DELEGATE')
    expect(coordinator.store.readDocument(`runtime:${taskId}`)?.value).not.toMatchObject({ takeover: true })
  })

  it('lets the Lead take over a correction without bypassing the frozen checks or review', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([
      delegate(), report('incorrect-report'), review('rework'),
      toolCallResponse('takeover', 'fusion_takeover', { reason: 'The correction is a small localized change; I will apply it and rerun the same acceptance.' }),
      edit('lead-edit'), report('lead-report'), review('accept'), textResponse('Corrected and verified.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', intent: 'DELEGATE', verification: 'verified' })
    expect(coordinator.store.readDocument(`runtime:${taskId}`)?.value).toMatchObject({ takeover: true })
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1)
    expect(coordinator.store.listDocumentIds(`check-invocation:${taskId}:`)).toHaveLength(2)
  })

  it.each([false, true])('restores an interrupted controller only after inspection and resumes the same persisted Worker (legacy evidence: %s)', async (legacyEvidence) => {
    const { ctx, parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), 'hang-slow',
      toolCallResponse('cold-rework', 'fusion_rework', { feedback: 'Resume the inspected addition task and submit the result.' }),
      edit(), report(), review('accept'), textResponse('Recovered and verified.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(2))
    const child = coordinator.state(taskId).acceptedChild
    await coordinator.pause(parent)
    await coordinator.close()
    if (legacyEvidence) {
      const document = store.readDocument(`runtime:${taskId}`)!
      const { changeBase: _omitted, ...legacy } = document.value as Record<string, unknown>
      store.writeDocument(`runtime:${taskId}`, document.revision, legacy)
    }
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(restored.state(taskId).control.recovering).toBe(true)
    await expect(restored.resume(parent, 'fixture-authorization')).rejects.toThrow('recover')
    expect(adapter.requests).toHaveLength(2)
    await restored.reconcile(parent, { commandId: 'human-recovery-test', note: 'Inspected calc.py and test_calc.py; the native child has stopped.' })
    expect(restored.state(taskId).control).toMatchObject({ mode: 'paused', recovering: false })
    await restored.resume(parent, 'fixture-authorization')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the inspected task.' }] }))
    await parent.whenIdle()
    expect(restored.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: child })
    expect(store.listDocumentIds('child:')).toEqual([`child:${child}`])
    const manifest = JSON.parse(Buffer.from(store.readArtifact(taskId, restored.state(taskId).lastReport!.changeManifest.id)).toString())
    expect(manifest.diffs[0].status).toBe(legacyEvidence ? 'unavailable-base' : 'text')
    if (!legacyEvidence) expect(Buffer.from(store.readArtifact(taskId, manifest.diffs[0].patch.id)).toString()).toContain('-    return a - b\n+    return a + b\n')
  })

  it('pauses a live Worker, drains cancellation and continues the same child after an explicit resume', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([
      delegate(), 'hang-slow',
      toolCallResponse('resume-rework', 'fusion_rework', { feedback: 'Resume the interrupted addition implementation and submit it.' }),
      edit(), report(), review('accept'), textResponse('Resumed, fixed and verified.'),
    ])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and verify it.' }] }))
    await waitForNative(() => expect(adapter.requests).toHaveLength(2))
    const child = coordinator.state(taskId).acceptedChild
    await coordinator.pause(parent)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'PAUSED', control: { mode: 'paused' } })
    expect(coordinator.state(taskId).lease).toBeUndefined()
    await coordinator.resume(parent, 'scripted-fixture-no-spend')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the paused task.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified', acceptedChild: child })
    await coordinator.activity.flush()
    expect(readFusionActivity(store, parent.id, 'resume-rework')).toMatchObject({ done: true,
      events: [{ source: { type: 'tool/call' } }, { source: { type: 'tool/result' } }] })
  })
})

const keepaliveRecords = (store: SqliteFusionStore) => store.listDocumentIds('keepalive:').map(id => store.readDocument(id)!.value as KeepaliveRecord)
const nativeUsage = (store: SqliteFusionStore) => store.listDocumentIds('usage:').map(id => store.readDocument(id)!.value as NativeUsageRecord)
async function backgroundKeepalive(options: { auxiliary?: Script; maxRequests?: number; enabled?: boolean; lead?: Script; worker?: Script } = {}) {
  const clock = new ManualKeepaliveClock()
  const fixture = await setup(options.lead ?? [delegate(false), textResponse('Worker started.')], options.worker ?? ['hang'], {
    clock, ...(options.enabled === false ? {} : { keepalive: { lead: true, worker: false } }),
    auxiliaryScript: options.auxiliary ?? [textResponse('x')], maxRequests: options.maxRequests,
  })
  fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
  await fixture.parent.whenIdle()
  await waitForNative(() => expect(fixture.adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
  return { ...fixture, clock }
}

describe('optional native cache keepalive', () => {
  it('retains the admitted prefix, uses public admission/accounting, and never writes auxiliary output or tools to either Session', async () => {
    const ping = toolCallResponse('aux-tool-must-not-execute', shellTool, { command: shellCommand('touch unwanted', "[IO.File]::WriteAllText((Join-Path $PWD 'unwanted'),'')"), description: 'Must not run' })
    ping.splice(ping.findIndex(chunk => chunk.type === 'usage'), 1,
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 91 } })
    const { parent, ctx, coordinator, adapter, store, clock, taskId, authorization, workspace } = await backgroundKeepalive({ auxiliary: [ping] })
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    const parentEvents = parent.session.snapshotEvents(), childEvents = child.session.snapshotEvents()
    const prefix = adapter.requests.filter(request => request.model === 'lead').at(-1)!
    const frozenInput = structuredClone(prefix.messages)
    clock.advance(KEEPALIVE_INTERVAL_MS - 1)
    expect(adapter.requests).toHaveLength(3)
    clock.advance(1)
    await waitForNative(() => expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')?.outcome).toBe('tool-calls'))
    const request = adapter.requests.at(-1)!
    expect(request).toMatchObject({ model: 'lead', maxTokens: 1, sessionId: parent.id })
    expect(request.purpose).toBeUndefined()
    expect(request.messages.slice(0, -1)).toEqual(frozenInput)
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: KEEPALIVE_PROMPT }] })
    expect(request.tools).toEqual(prefix.tools)
    expect(parent.session.snapshotEvents()).toEqual(parentEvents)
    expect(child.session.snapshotEvents()).toEqual(childEvents)
    expect(() => readFileSync(join(workspace, 'unwanted'))).toThrow()
    expect(clock.timers.size).toBe(1)
    const usage = nativeUsage(store).filter(row => row.purpose === 'cache-keepalive')
    expect(usage).toMatchObject([{ taskId, role: 'lead', auxiliary: { iteration: 1 }, nativeStreamInvocations: 1,
      upstreamHttpCalls: null, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null }])
    expect(store.readDocument(`budget:${authorization && authorization.authorizationId}`)?.value).toMatchObject({ requests: 4, reservedOutputTokens: 24_001 })
    const checks = store.listDocumentIds(`context-request:${taskId}:`).map(id => store.readDocument(id)!.value)
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'cache-keepalive', admitted: true,
      measurement: expect.objectContaining({ reservedOutputTokens: 1 }) })]))
  })

  it('uses 285-second wake deadlines, at most 11 serial attempts, and stops without recursive scheduling', async () => {
    const { clock, adapter, store } = await backgroundKeepalive({ auxiliary: Array.from({ length: KEEPALIVE_ATTEMPTS }, () => textResponse('x')) })
    for (let i = 1; i <= KEEPALIVE_ATTEMPTS; i++) {
      clock.advance(KEEPALIVE_INTERVAL_MS)
      await waitForNative(() => expect(keepaliveRecords(store).some(row => row.successes === i)).toBe(true))
      expect(adapter.requests.filter(request => request.maxTokens === 1)).toHaveLength(i)
    }
    expect(clock.timers.size).toBe(0)
    expect(keepaliveRecords(store)).toEqual(expect.arrayContaining([expect.objectContaining({ attempts: 11, successes: 11, state: 'stopped', stopReason: 'attempt-limit' })]))
    clock.advance(KEEPALIVE_INTERVAL_MS * 12)
    expect(adapter.requests).toHaveLength(14)
  })

  it('deducts generation time from the first delay and schedules the next deadline before awaiting a slow ping', async () => {
    const clock = new ManualKeepaliveClock()
    const { parent, store, adapter } = await setup([delegate(false), () => { clock.time += 120_000; return textResponse('Working.') }], ['hang'], {
      clock, keepalive: { lead: true, worker: false }, auxiliaryScript: [() => { clock.time += 200_000; return textResponse('x') }, textResponse('y')],
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix it.' }] }))
    await parent.whenIdle()
    expect(clock.time).toBe(120_000)
    expect([...clock.timers.values()].map(row => row.at)).toEqual([285_000])
    clock.advance(165_000)
    await waitForNative(() => expect(keepaliveRecords(store).some(row => row.successes === 1)).toBe(true))
    expect(clock.time).toBe(485_000)
    expect([...clock.timers.values()].map(row => row.at)).toEqual([570_000])
    clock.advance(85_000)
    await waitForNative(() => expect(adapter.requests.filter(request => request.maxTokens === 1)).toHaveLength(2))
  })

  it('stops on failure and does not infer absent usage fields or refund reservations', async () => {
    const { clock, adapter, store, authorization } = await backgroundKeepalive({ auxiliary: [] })
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(keepaliveRecords(store).some(row => row.stopReason === 'request-failed')).toBe(true))
    expect(clock.timers.size).toBe(0)
    expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')).toMatchObject({ outcome: 'error',
      upstreamHttpCalls: null, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null })
    expect(store.readDocument(`budget:${authorization && authorization.authorizationId}`)?.value).toMatchObject({ requests: 4, reservedOutputTokens: 24_001 })
    clock.advance(KEEPALIVE_INTERVAL_MS * 2)
    expect(adapter.requests).toHaveLength(4)
  })

  it('makes no ping when the shared request allowance is exhausted', async () => {
    const { clock, adapter, store } = await backgroundKeepalive({ maxRequests: 3 })
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(keepaliveRecords(store).some(row => row.stopReason === 'request-failed')).toBe(true))
    expect(adapter.requests).toHaveLength(3)
    expect(nativeUsage(store).filter(row => row.purpose === 'cache-keepalive')).toEqual([])
    expect(clock.timers.size).toBe(0)
  })

  it('aborts and drains an in-flight ping on pause, retaining its reservation and requiring a fresh normal generation after resume', async () => {
    const { parent, coordinator, store, adapter, clock } = await backgroundKeepalive({ auxiliary: ['hang-slow'] })
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(adapter.requests).toHaveLength(4))
    const signal = adapter.requests.at(-1)!.signal!
    await coordinator.pause(parent)
    expect(signal.aborted).toBe(true)
    expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')?.outcome).toBe('aborted')
    expect(clock.timers.size).toBe(0)
    await coordinator.resume(parent, 'scripted-fixture')
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(4)
  })

  it('drains old auxiliary work before a replacement AgentLoop request and stops when the runtime closes', async () => {
    const { parent, coordinator, adapter, store, clock } = await backgroundKeepalive({
      auxiliary: ['hang-slow'], lead: [delegate(false), textResponse('Working.'), textResponse('Still working.')],
    })
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(adapter.requests).toHaveLength(4))
    const old = adapter.requests.at(-1)!
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Please keep going.' }] }))
    await parent.whenIdle()
    expect(old.signal?.aborted).toBe(true)
    expect(adapter.requests).toHaveLength(5)
    expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')?.outcome).toBe('aborted')
    expect(clock.timers.size).toBe(1)
    await coordinator.close()
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(5)
  })

  it('invalidates the timer before a public compaction call and never starts one from an auxiliary call', async () => {
    const { ctx, parent, store, adapter, clock } = await backgroundKeepalive({ lead: [delegate(false), textResponse('Working.'), textResponse('Summary.')] })
    for await (const _ of ctx.llm.stream({ provider: 'test-native', model: 'lead', sessionId: parent.id,
      purpose: 'compaction', maxTokens: 100, messages: [createUserMessage({ content: [{ type: 'text', text: 'Summarize.' }] })] })) { /* drain native summary */ }
    expect(keepaliveRecords(store)).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'stopped', stopReason: 'compaction' })]))
    expect(nativeUsage(store).some(row => row.purpose === 'compaction')).toBe(true)
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(4)
  })

  it('stops the idle Lead loop when its background Worker finishes', async () => {
    const { ctx, coordinator, taskId, clock, adapter } = await backgroundKeepalive()
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    child.cancel({ kind: 'user' }, { keepInbox: true })
    await child.whenIdle()
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS)
    expect(adapter.requests).toHaveLength(3)
  })

  it('unset stays unarmed without cache evidence and leaves ordinary sessions without timers or auxiliary calls', async () => {
    const { clock, store, adapter, ctx } = await backgroundKeepalive({ enabled: false, lead: [delegate(false), textResponse('Working.'), textResponse('Ordinary.')] })
    const other = (await ctx.agents.create({ sessionId: SessionId('ordinary-keepalive'), agentOptions: { provider: 'test-native', model: 'ordinary' } })).agent
    other.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await other.whenIdle()
    expect(clock.timers.size).toBe(0)
    expect(keepaliveRecords(store).every(row => row.state === 'stopped' && row.stopReason === 'no-cache-evidence')).toBe(true)
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(4)
  })

  it('unset arms automatically for a Lead whose route reports cache reads (round 4: cold Lead cache)', async () => {
    const cached = (text: string) => textResponse(text).map(chunk => chunk.type === 'usage'
      ? { ...chunk, usage: { ...(chunk as { usage: object }).usage, cacheReadTokens: 8 } } : chunk) as ReturnType<typeof textResponse>
    const { clock, store } = await backgroundKeepalive({ enabled: false, lead: [delegate(false), cached('Worker started.')] })
    expect(clock.timers.size).toBe(1)
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(keepaliveRecords(store).some(row => row.successes === 1)).toBe(true))
  })

  it('pings at the per-model interval the user set and records each ping for the settings page', async () => {
    const clock = new ManualKeepaliveClock()
    const fixture = await setup([delegate(false), textResponse('Worker started.')], ['hang'], {
      clock, keepalive: { lead: true, worker: false }, auxiliaryScript: [textResponse('x')] })
    fixture.coordinator.cachePolicy.save('test-native', 'lead', { intervalSeconds: 600 })
    fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await fixture.parent.whenIdle()
    await waitForNative(() => expect(fixture.adapter.requests.filter(request => request.model === 'worker')).toHaveLength(1))
    expect([...clock.timers.values()].map(timer => timer.at)).toEqual([600_000])
    clock.advance(KEEPALIVE_INTERVAL_MS)
    expect(keepaliveRecords(fixture.store).every(row => row.attempts === 0)).toBe(true)
    clock.advance(600_000 - KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(fixture.coordinator.cachePolicy.stats('test-native', 'lead')?.totals.pings).toBe(1))
    expect(fixture.coordinator.cachePolicy.stats('test-native', 'lead')!.samples.at(-1)).toMatchObject({ ping: true, gapSeconds: 600 })
  })

  it('an explicit off wins over automatic arming', async () => {
    const cached = (text: string) => textResponse(text).map(chunk => chunk.type === 'usage'
      ? { ...chunk, usage: { ...(chunk as { usage: object }).usage, cacheReadTokens: 8 } } : chunk) as ReturnType<typeof textResponse>
    const clock = new ManualKeepaliveClock()
    const fixture = await setup([delegate(false), cached('Worker started.')], ['hang'], { clock, keepalive: { lead: false, worker: false } })
    fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await fixture.parent.whenIdle()
    expect(clock.timers.size).toBe(0)
    expect(keepaliveRecords(fixture.store)).toEqual([])
  })
})

describe('cache keepalive control boundaries', () => {
  it('fails context admission without spending, compacting or pausing the active task', async () => {
    const { clock, store, adapter, modelContext, coordinator, taskId, authorization } = await backgroundKeepalive()
    modelContext.window = 100
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(keepaliveRecords(store).some(row => row.stopReason === 'request-failed')).toBe(true))
    expect(nativeUsage(store).filter(row => row.purpose === 'cache-keepalive')).toEqual([])
    expect(adapter.requests).toHaveLength(3)
    expect(store.readDocument(`budget:${authorization && authorization.authorizationId}`)?.value).toMatchObject({ requests: 3, reservedOutputTokens: 24_000 })
    expect(store.listDocumentIds('context-recovery:')).toEqual([])
    expect(coordinator.state(taskId).control.mode).toBe('running')
  })

  it.each(['budget', 'approval', 'recovery', 'unknown-effects'] as const)('invalidates queued keepalive when the %s control gate closes', async gate => {
    const { clock, store, adapter, coordinator, taskId } = await backgroundKeepalive()
    if (gate === 'budget') coordinator.append(taskId, 'budget/blocked', { reason: 'scripted allowance blocked' })
    else if (gate === 'recovery') coordinator.append(taskId, 'recovery/needed', { reason: 'scripted recovery required' })
    else if (gate === 'unknown-effects') coordinator.append(taskId, 'effect/outcome-unknown', {
      operationId: coordinator.state(taskId).currentWorkOrder!.operationId, reason: 'scripted unknown effect',
    })
    else coordinator.append(taskId, 'approval/pending', { approval: {
      id: 'scripted-approval', taskId, revision: 1, operationId: 'fixture-op', argsDigest: 'fixture-args',
      snapshot: 'fixture-snapshot', permissionPolicyDigest: 'fixture-policy', state: 'pending',
    } })
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS)
    expect(adapter.requests).toHaveLength(3)
    expect(keepaliveRecords(store)).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'stopped', stopReason: 'task-gated' })]))
  })

  it('does not keep a finished direct conversation alive', async () => {
    const clock = new ManualKeepaliveClock()
    const { parent, adapter, store } = await setup([textResponse('Hello.')], [], {
      clock, keepalive: { lead: true, worker: true }, auxiliaryScript: [textResponse('x')],
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(1)
    expect(nativeUsage(store).some(row => row.purpose === 'cache-keepalive')).toBe(false)
  })

  it('keeps Worker inputs alive only while that Worker is active, with separate accounting', async () => {
    const clock = new ManualKeepaliveClock()
    const { parent, ctx, coordinator, taskId, store, adapter } = await setup([delegate(false), textResponse('Working.')], [edit(), report()], {
      clock, keepalive: { lead: false, worker: true }, auxiliaryScript: [textResponse('x')],
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const dispose = ctx.on('tools/execute', async (exec, next) => {
      if (exec.callId === 'edit') { exec.signal.addEventListener('abort', release, { once: true }); await gate }
      return next()
    })
    cleanups.push(async () => { release(); dispose() })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    await waitForNative(() => expect(coordinator.effects.pending(taskId)).toHaveLength(1))
    const child = ctx.agents.get(SessionId(coordinator.state(taskId).acceptedChild!))!
    clock.advance(KEEPALIVE_INTERVAL_MS)
    await waitForNative(() => expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')?.outcome).toBe('stop'))
    expect(nativeUsage(store).find(row => row.purpose === 'cache-keepalive')).toMatchObject({ sessionId: child.id, role: 'worker' })
    expect(adapter.requests.at(-1)).toMatchObject({ model: 'worker', maxTokens: 1 })
    release()
    await child.whenIdle()
    expect(clock.timers.size).toBe(0)
  })

  it('never restores timers or retained prompts from a replaced runtime', async () => {
    const { coordinator, parent, ctx, store, adapter, clock } = await backgroundKeepalive()
    const profile = coordinator.options.profile
    await coordinator.close()
    const replacement = new FusionCoordinator(ctx, store, { profile, workerTools: [shellTool], keepaliveClock: clock, authorizeRequest: () => undefined })
    cleanups.push(() => replacement.close())
    expect(replacement.bindings.read(parent.id)?.binding.selected).toBe(true)
    expect(clock.timers.size).toBe(0)
    clock.advance(KEEPALIVE_INTERVAL_MS * 20)
    expect(adapter.requests).toHaveLength(3)
    for (const record of keepaliveRecords(store)) {
      expect(JSON.stringify(record)).not.toContain('Correct addition')
      expect(record.inputDigest).toMatch(/^[a-f0-9]{64}$/)
    }
  })
})

describe('Lead acceptance amendment', () => {
  const missingInterpreter = toolCallResponse('delegate-missing', 'fusion_delegate', {
    goal: 'Correct addition', brief: 'Fix calc.py add and preserve the test. Submit a report after implementing.',
    constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py', 'test_extra.py'],
    checks: [{ id: 'addition', description: 'Existing addition test passes', command: py('python3 -B -m unittest -v test_calc && ./fusion-missing-runner'),
      kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
  })
  const needsDecision = toolCallResponse('review-needs', 'fusion_review_result', { decision: 'needs-decision',
    reason: 'The code is right but the frozen interpreter does not exist on this host (exit 127).' })
  const amend = (definitionPaths: string[], id = 'amend') => toolCallResponse(id, 'fusion_rework', {
    feedback: 'The frozen interpreter is missing on this host. Re-verify with python3; keep the implementation.',
    checks: [{ id: 'addition', description: 'Existing addition test passes with python3', command: py('python3 -B -m unittest -v test_calc'),
      kind: 'test', parser: 'unittest', definitionPaths }],
  })

  it('lets the Lead correct its broken check and verifies the same Worker with the new plan', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      missingInterpreter, needsDecision, amend(['test_calc.py']), review('accept'), textResponse('Verified with python3.'),
    ], [edit(), report(), report('re-report')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    expect(store.events(taskId).filter(event => event.type === 'work-order/acceptance-amended')).toHaveLength(1)
    const [auditId] = store.listDocumentIds(`acceptance-amendment:${taskId}:`)
    expect(store.readDocument(auditId!)?.value).toMatchObject({
      before: [{ command: py('python3 -B -m unittest -v test_calc && ./fusion-missing-runner') }], after: [{ command: py('python3 -B -m unittest -v test_calc') }] })
    expect(JSON.stringify(toolResults(parent))).toContain('checkDefinitionProblem')
    expect(coordinator.state(taskId).currentWorkOrder?.acceptance[0]?.description).toContain('python3')
  })

  it('refuses an amendment that drops a protected definition path', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      missingInterpreter, needsDecision, amend([], 'amend-weaken'), textResponse('The amendment was refused.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toMatch(/Test checks need a count parser and frozen test files|must keep every protected definition path/)
    expect(store.events(taskId).filter(event => event.type === 'work-order/acceptance-amended')).toHaveLength(0)
    expect(coordinator.state(taskId).phase).toBe('NEEDS_DECISION')
  })

  it('refuses an amendment that keeps the path name but drops it from a multi-check set', async () => {
    const { parent, store, taskId } = await setup([
      missingInterpreter, needsDecision, toolCallResponse('amend-swap', 'fusion_rework', {
        feedback: 'Use a different test file.',
        checks: [{ id: 'addition', description: 'Extra test only', command: py('python3 -B -m unittest -v test_calc'),
          kind: 'test', parser: 'unittest', definitionPaths: ['calc.py'] }],
      }), textResponse('Refused.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('must keep every protected definition path')
    expect(store.events(taskId).filter(event => event.type === 'work-order/acceptance-amended')).toHaveLength(0)
  })
})

describe('Lead scope expansion', () => {
  const narrow = toolCallResponse('delegate-narrow', 'fusion_delegate', {
    goal: 'Correct addition', brief: 'Fix calc.py add. Submit a report after implementing.',
    constraints: [], allowedPaths: ['calc.py'],
    checks: [{ id: 'addition', description: 'Addition tests pass', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest' }],
  })
  const needsDecision = toolCallResponse('review-scope', 'fusion_review_result', { decision: 'needs-decision',
    reason: 'calc.py is correct, but test_calc.py lacks a zero case and lies outside the frozen allowedPaths.' })
  const widen = (paths: string[], id = 'widen') => toolCallResponse(id, 'fusion_rework', {
    feedback: 'Add a zero-sum regression test to test_calc.py; keep the implementation.', addAllowedPaths: paths })
  const appendTest = toolCallResponse('append-test', shellTool, { command: shellCommand(
    "printf '    def test_zero(self):\\n        self.assertEqual(add(0, 0), 0)\\n' >> test_calc.py",
    "[IO.File]::AppendAllText((Join-Path $PWD 'test_calc.py'), \"    def test_zero(self):`n        self.assertEqual(add(0, 0), 0)`n\")"), description: 'Add a zero-sum test' })
  const acceptNamed = toolCallResponse('review-accept-named', 'fusion_review_result', { decision: 'accept',
    reason: 'calc.py adds both inputs; test_calc.py keeps its original test_add expectation and only gains test_zero; the native unittest check passed.' })

  it('lets the Lead add a path after a report and verifies the widened change', async () => {
    const { parent, coordinator, store, taskId, adapter } = await setup([
      narrow, needsDecision, widen(['test_calc.py']), acceptNamed, textResponse('Added the zero case.'),
    ], [edit(), report(), appendTest, report('re-report')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and cover zero.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(coordinator.state(taskId).currentWorkOrder?.allowedPaths).toEqual(['calc.py', 'test_calc.py'])
    expect(store.events(taskId).filter(event => event.type === 'work-order/scope-expanded')).toHaveLength(1)
    const [auditId] = store.listDocumentIds(`scope-expansion:${taskId}:`)
    expect(store.readDocument(auditId!)?.value).toMatchObject({ before: ['calc.py'], added: ['test_calc.py'] })
    expect(JSON.stringify(adapter.requests.filter(request => request.model === 'worker').at(-1))).toContain('added these paths to the frozen allowedPaths')
    expect(store.listDocumentIds('child:')).toHaveLength(1)
  })

  it('keeps the rewritten-test gate on files added to the scope', async () => {
    // Rewrites an original assertion line (still passing): the gate must see the delegation-time bytes.
    const rewriteTest = toolCallResponse('rewrite-test', shellTool, { command: `${python} -c "import pathlib; p = pathlib.Path('test_calc.py'); p.write_text(p.read_text().replace('add(2, 3)', 'add(3, 2)'))"`,
      description: 'Rewrite the existing assertion' })
    const { parent, coordinator, taskId } = await setup([
      narrow, needsDecision, widen(['test_calc.py']), review('accept'), textResponse('Refused until named.'),
    ], [edit(), report(), rewriteTest, report('re-report')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and cover zero.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('Existing tests lost or changed original lines')
    expect(coordinator.state(taskId).phase).toBe('REVIEWING')
  })

  it('refuses a path that escapes the workspace', async () => {
    const { parent, store, taskId } = await setup([
      narrow, needsDecision, widen(['../outside.py'], 'widen-escape'), textResponse('Refused.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and cover zero.' }] }))
    await parent.whenIdle()
    expect(store.events(taskId).filter(event => event.type === 'work-order/scope-expanded')).toHaveLength(0)
    expect(store.listDocumentIds(`scope-expansion:${taskId}:`)).toHaveLength(0)
  })
})

describe('acceptance program preflight', () => {
  const withCommand = (id: string, command: string) => toolCallResponse(id, 'fusion_delegate', {
    goal: 'Correct addition', brief: 'Fix calc.py add and preserve the test. Submit a report after implementing.',
    constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'],
    checks: [{ id: 'addition', description: 'Existing addition test passes', command, kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
  })

  it('refuses a program this host lacks before any Worker request, then accepts the corrected handoff', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      withCommand('delegate-missing', 'FOO=1 fusion-no-such-python -B -m unittest -v test_calc'), delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition and preserve the tests.' }] }))
    await parent.whenIdle()
    const errors = toolResults(parent).map(result => result.message).filter(block => block.role === 'tool' && block.isError)
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors)).toContain('fusion-no-such-python')
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.events(taskId).filter(event => event.type === 'work-order/prepared')).toHaveLength(1)
    expect(adapter.requests.filter(request => request.model === 'worker').length).toBeGreaterThan(0)
  })
})

describe('review-only delegation', () => {
  it('completes a delegated task without automated checks and tells the Lead the review is the only verification', async () => {
    const reviewOnly = toolCallResponse('delegate-review-only', 'fusion_delegate', {
      goal: 'Correct addition', brief: 'Fix calc.py add. There is no runnable acceptance command for this change.',
      constraints: ['Do not change test_calc.py'], allowedPaths: ['calc.py'], checks: [],
    })
    const { parent, coordinator, taskId } = await setup([reviewOnly, review('accept'), textResponse('Reviewed the diff; no automated checks ran.')], [edit(), report()])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED' })
    const results = JSON.stringify(toolResults(parent))
    expect(results).toContain('\\"automatedChecks\\":0')
    expect(results).toContain('reviewOnly')
  })

  it('rejects an out-of-range per-check timeout before any Worker request', async () => {
    const slow = toolCallResponse('delegate-slow', 'fusion_delegate', {
      goal: 'Correct addition', brief: 'Fix calc.py add.', constraints: [], allowedPaths: ['calc.py'],
      checks: [{ id: 'addition', description: 'Tests', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest',
        definitionPaths: ['test_calc.py'], timeoutSeconds: 99_999 }],
    })
    const { parent, adapter } = await setup([slow, textResponse('Rejected.')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('timeoutSeconds must be')
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(0)
  })
})


describe('model-like native execution', () => {
  it('answers without a cwd, Worker, output override or task snapshot', async () => {
    const { parent, coordinator, store, adapter, taskId } = await setup([textResponse('Hello')], undefined,
      { modelLike: true, noCwd: true, adapterOutput: null })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]!.maxTokens).toBeUndefined()
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Fusion task state from the durable ledger')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'unverified' })
    expect(coordinator.state(taskId).acceptedChild).toBeUndefined()
    expect(store.readDocument(`runtime:${taskId}`)).toBeUndefined()
  })

  it('runs native shell effects and releases the writer without takeover or finish', async () => {
    const { parent, coordinator, adapter, taskId, workspace } = await setup([edit(), textResponse('Done')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition directly.' }] }))
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'unverified' })
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(coordinator.state(taskId).acceptedChild).toBeUndefined()
    expect(adapter.requests[0]!.tools!.some(tool => tool.name === shellTool)).toBe(true)
    expect(JSON.stringify(adapter.requests)).not.toContain('Fusion task state from the durable ledger')
  })

  it('refuses large direct Lead writing and completes through the Sidekick instead', async () => {
    const big = toolCallResponse('big-write', 'write', { file_path: 'calc.py', content: Array.from({ length: 40 }, (_, i) => `# line ${i}`).join('\n') })
    const { parent, coordinator, adapter, taskId, workspace } = await setup([big, delegate(), review('accept'), textResponse('Delegated and verified.')],
      [edit(), report()], { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Implement the addition fix.' }] }))
    await parent.whenIdle()
    const results = JSON.stringify(toolResults(parent))
    expect(results).toContain('Direct Lead writing is for small edits')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).not.toContain('# line 0')
    expect(coordinator.state(taskId), results).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests.filter(request => request.model === 'worker').length).toBeGreaterThan(0)
  })

  it('accepts a minimal delegation with only a command per check', async () => {
    const minimal = toolCallResponse('delegate-minimal', 'fusion_delegate', { goal: 'Correct addition', brief: 'Fix calc.py add.',
      allowedPaths: ['calc.py'], checks: [{ command: py('python3 -B -m unittest -v test_calc'), parser: 'unittest' }] })
    const { parent, coordinator, taskId } = await setup([minimal, review('accept'), textResponse('Verified.')], [edit(), report()], { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Delegate the addition fix.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(coordinator.state(taskId).currentWorkOrder?.acceptance[0]).toMatchObject({ id: 'check-1', verificationKind: 'test' })
  })

  it('refuses an endless read loop so the Lead has to act', async () => {
    const reads = Array.from({ length: 27 }, (_, i) => toolCallResponse(`read-${i}`, 'read', { file_path: 'calc.py', offset: 1, limit: 1 }))
    const { parent } = await setup([...reads, textResponse('Acting on what I know.')], undefined, { modelLike: true, files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review calc.py.' }] }))
    await parent.whenIdle()
    const results = toolResults(parent).map(result => JSON.stringify(result.message.content))
    expect(results.slice(0, 25).every(text => !text.includes('consecutive read-only calls'))).toBe(true)
    expect(results[25]).toContain('25 consecutive read-only calls without any other action')
  })

  it('counts small direct edits per task so they cannot add up to an implementation', async () => {
    const chunk = (id: string) => toolCallResponse(id, 'write', { file_path: `part-${id}.py`, content: Array.from({ length: 25 }, (_, i) => `x${i} = ${i}`).join('\n') })
    const { parent, workspace } = await setup([chunk('a'), chunk('b'), chunk('c'), chunk('d'), textResponse('Stopped at the boundary.')], undefined, { modelLike: true, files: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Write the parts directly.' }] }))
    await parent.whenIdle()
    expect(['a', 'b', 'c'].every(id => readFileSync(join(workspace, `part-${id}.py`), 'utf8').includes('x24'))).toBe(true)
    expect(() => readFileSync(join(workspace, 'part-d.py'))).toThrow()
    expect(JSON.stringify(toolResults(parent))).toContain('this task 75/80 lines')
  })

  it('keeps real delegated checks/review with role defaults and no cumulative worker cap', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([delegate(), review('accept'), textResponse('Verified')],
      [edit(), report()], { modelLike: true, maxWorkerSteps: 1, adapterOutput: { lead: 2000, worker: 4000 } })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Delegate and verify the addition fix.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    const workers = adapter.requests.filter(request => request.model === 'worker')
    expect(workers).toHaveLength(2)
    expect(workers.every(request => request.maxTokens === 4000)).toBe(true)
    expect(JSON.stringify(adapter.requests)).not.toContain('Fusion task state from the durable ledger')
  })
})


describe('model-like text delegation', () => {
  it('delegates text without filesystem tools and reviews without claiming automated checks', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      toolCallResponse('text', 'fusion_delegate_text', { goal: 'Summarize', brief: 'Summarize this supplied text: apples are fruit.', constraints: ['Use supplied material'] }),
      review('accept'), textResponse('Apples are fruit.'),
    ], [toolCallResponse('report', 'fusion_submit_result', { summary: 'Apples are fruit.', status: 'completed', unresolved: [] })],
    { modelLike: true, noCwd: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Summarize the supplied text with your Sidekick.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED' })
    expect(adapter.requests.find(request => request.model === 'worker')!.tools!.some(tool => tool.name === shellTool)).toBe(false)
    expect(store.events(taskId).filter(event => event.type === 'lease/acquired')).toHaveLength(0)
    expect(readFusionStatus(store, parent.id).task?.automatedChecks).toBe(0)
  })
})

const providerQuota = (): StreamChunk[] => [{ type: 'finish', reason: { kind: 'error', failure: {
  code: 'QUOTA', message: 'Private account message must not enter the status UI', providerRetryAfterMs: 1000,
} } }]

describe('model-like local continuation', () => {
  it('records canonical Lead QUOTA without a reset time and wakes once through the native inbox', async () => {
    const { parent, coordinator, store, adapter, taskId } = await setup([providerQuota(), textResponse('Continued')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue this task' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const status = readFusionStatus(store, parent.id)
    expect(status.task?.stage).toBe('等待模型')
    expect(status.task?.modelControl?.waits.lead).toMatchObject({ code: 'QUOTA', quotaResetAt: null })
    expect(JSON.stringify(status)).not.toContain('Private account')
    const revision = status.task!.modelControl!.revision
    await coordinator.modelControl.continue(parent.id, taskId, revision)
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    const sent = parent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source?.kind === 'plugin:dsh-model-fusion'))
    expect(sent).toHaveLength(1)
    expect(readFusionStatus(store, parent.id).task?.modelControl?.operation?.state).toBe('delivered')
    await expect(coordinator.modelControl.continue(parent.id, taskId, revision)).rejects.toThrow()
    expect(adapter.requests).toHaveLength(2)
  })

  it('changes the effective Lead route without mutating the frozen profile or replaying the old error', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([providerQuota(), textResponse('Resumed with replacement')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work' }] }))
    await parent.whenIdle()
    const binding = coordinator.bindings.read(parent.id)!.binding
    const revision = readFusionStatus(store, parent.id).task!.modelControl!.revision
    await coordinator.modelControl.continue(parent.id, taskId, revision, { role: 'lead', route: { provider: 'test-native', model: 'replacement' } })
    await parent.whenIdle()
    expect(adapter.requests.map(request => request.model)).toEqual(['lead', 'replacement'])
    expect(coordinator.bindings.read(parent.id)!.binding.profile.digest).toBe(binding.profile.digest)
    expect(readFusionStatus(store, parent.id).task!.models.lead.model).toBe('replacement')
    expect(readFusionStatus(store, parent.id).task!.modelControl!.epoch).toBe(1)
  })

  it('cancels a scheduled retry after new user input and never polls the provider', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([providerQuota(), textResponse('Should not run')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await coordinator.modelControl.schedule(parent.id, taskId, readFusionStatus(store, parent.id).task!.modelControl!.revision, new Date(Date.now() + 60_000).toISOString())
    expect(adapter.requests).toHaveLength(1)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Change the task' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(readFusionStatus(store, parent.id).task!.modelControl!.schedule!.state).toBe('cancelled')
    expect(adapter.requests).toHaveLength(1)
  })

  it('continues the same Sidekick after worker QUOTA without automatic takeover', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), textResponse('Sidekick needs quota recovery.'),
      toolCallResponse('retry-sidekick', 'fusion_rework', { feedback: 'Continue the original assignment.' }),
      review('accept'), textResponse('Verified'),
    ], [providerQuota(), toolCallResponse('recover-state', 'fusion_read_state', {}), edit(), report()], { modelLike: true })
    const allowFollowup = holdLeadForFollowup(adapter)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition' }] }))
    await parent.whenIdle()
    const workerId = coordinator.state(taskId).acceptedChild
    const status = readFusionStatus(store, parent.id)
    expect(status.task?.modelControl?.waits.worker?.code).toBe('QUOTA')
    expect(JSON.stringify(toolResults(parent))).toContain('worker-unavailable')
    allowFollowup()
    await coordinator.modelControl.continue(parent.id, taskId, status.task!.modelControl!.revision)
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify({ tools: toolResults(parent), events: coordinator.ctx.agents.get(SessionId(workerId!))?.session.snapshotEvents().slice(-14) })).toMatchObject({ phase: 'COMPLETED', acceptedChild: workerId })
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(4)
  })
})

 describe('model-like context and progress', () => {
  it('restores paginated state after native compaction and a cold Sidekick activation', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId } = await setup([
      delegate(), textResponse('Need more detail'), textResponse('Native summary'),
      toolCallResponse('read-state', 'fusion_read_state', { limit: 24000 }),
      toolCallResponse('continue', 'fusion_rework', { feedback: 'Finish the original assignment and report.' }),
      review('accept'), textResponse('Verified'),
    ], [textResponse('Need clarification'), toolCallResponse('worker-restore', 'fusion_read_state', { limit: 24000 }), edit(), report()], { modelLike: true })
    await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
    const allowFollowup = holdLeadForFollowup(adapter)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition and preserve the test.' }] }))
    await parent.whenIdle()
    let compacted = false
    const dispose = parent.ctx.on('agent/pre-step', async ({ signal }, next) => {
      if (!compacted) {
        compacted = true
        const nodes = parent.session.surface.nodes.filter(seq => parent.session.eventAt(seq)?.type !== 'system/message')
        expect(await ctx.compaction.compactRegion(nodes[0]!, nodes.at(-1)!, parent, signal)).not.toBeNull()
        expect(coordinator.onDemand.blocked(parent, coordinator.bindings.read(parent.id)!.binding)).toContain('Read fusion_read_state')
      }
      return next()
    })
    cleanups.push(async () => dispose())
    allowFollowup()
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the original task.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    // The compacted Lead must restore. A Worker merely reactivated from its persisted session keeps its
    // transcript, so it is not gated (the study showed the old gate stalling a cheap Worker).
    const restored = store.listDocumentIds(`restore-index:${taskId}:`).map(id => ({ id, ...(store.readDocument(id)!.value as { restored: boolean }) }))
    expect(restored.some(row => row.id.endsWith(`:${parent.id}`))).toBe(true)
    expect(restored.every(row => row.restored)).toBe(true)
    const pointers = adapter.requests.flatMap(request => request.messages).flatMap(message =>
      message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot' ? message.source.sections : []).filter(section => section.name === 'fusion:resume')
    expect(pointers.length).toBeGreaterThan(0)
    expect(pointers.every(pointer => pointer.text.length < 600)).toBe(true)
  })

  it('stops unchanged failing tool attempts but does not cap successful work', async () => {
    const fail = (id: string) => toolCallResponse(id, shellTool, { command: 'fusion_missing_program', description: 'same attempt' })
    const { parent, store, adapter } = await setup([fail('1'), fail('2'), fail('3'), fail('4')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try the command' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('NO_PROGRESS')
    expect(readFusionStatus(store, parent.id).task?.stage).not.toBe('完成')
  })
})

 describe('model-like scheduling and native retry', () => {
  it.each(['normal', 'always'] as const)('stops QUOTA under the native %s retry policy without spinning', async retryMode => {
    const { ctx, parent, adapter, store } = await setup([providerQuota(), textResponse('Must not run')], undefined, { modelLike: true, retryMode })
    await ctx.plugin(LlmRetry)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('QUOTA')
  })

  it('leaves a transient RATE_LIMIT to native retry and clears no permissions', async () => {
    const { ctx, parent, adapter, store } = await setup([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Temporary', providerRetryAfterMs: 1 } } }],
      textResponse('Retried natively'),
    ], undefined, { modelLike: true, retryMode: 'normal' })
    await ctx.plugin(LlmRetry)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits).toEqual({})
  })

  it('fires a recovered scheduled continuation only once and stops if quota is still exhausted', async () => {
    const { ctx, parent, coordinator, adapter, store, taskId } = await setup([providerQuota(), providerQuota(), textResponse('Must not run')], undefined, { modelLike: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work' }] }))
    await parent.whenIdle()
    vi.useFakeTimers()
    try {
      await coordinator.modelControl.schedule(parent.id, taskId, readFusionStatus(store, parent.id).task!.modelControl!.revision, new Date(Date.now() + 100).toISOString())
      await coordinator.close()
      const restored = new FusionCoordinator(ctx, store, coordinator.options)
      cleanups.push(async () => restored.close())
      await vi.advanceTimersByTimeAsync(100)
      await parent.whenIdle()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(adapter.requests).toHaveLength(2)
      expect(readFusionStatus(store, parent.id).task?.modelControl?.schedule?.state).toBe('cancelled')
      expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('QUOTA')
    } finally { vi.useRealTimers() }
  })
})

it('does not replay an unacknowledged continuation and accepts explicit local reconciliation without a workspace', async () => {
  const { parent, coordinator, adapter, store, taskId } = await setup([providerQuota(), textResponse('After inspection')], undefined, { modelLike: true, noCwd: true })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work without a workspace' }] }))
  await parent.whenIdle()
  const id = `model-control:${parent.id}`, row = store.readDocument(id)!
  store.writeDocument(id, row.revision, { ...row.value as object, operation: { id: 'interrupted', taskId, state: 'dispatching' } })
  await expect(coordinator.modelControl.continue(parent.id, taskId, row.revision + 1)).rejects.toThrow('投递结果未知')
  expect(adapter.requests).toHaveLength(1)
  await coordinator.reconcile(parent, { commandId: 'human-command', note: 'I inspected the inbox and confirmed that this continuation was not delivered.' })
  expect(readFusionStatus(store, parent.id).task?.modelControl?.operation?.state).toBe('failed')
  await coordinator.modelControl.continue(parent.id, taskId, readFusionStatus(store, parent.id).task!.modelControl!.revision)
  await parent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
})

// These adapters deliberately disregard the role prompt. Only native enforcement can pass them.
describe('adaptive model workflow', () => {
  const options = { modelLike: true, enforcedWorkflow: 'enforced-v2', files: true } as const

  it('executes direct work without a line quota and releases its lease on completion', async () => {
    const content = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
    const { parent, coordinator, taskId, workspace } = await setup([
      toolCallResponse('large-direct', 'write', { file_path: 'note.txt', content }), textResponse('Saved the supplied text.'),
    ], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save my supplied text directly.' }] }))
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe(content)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'unverified' })
    expect(coordinator.state(taskId).acceptedChild).toBeUndefined()
    expect(coordinator.leases.current(workspace)).toBeUndefined()
  })

  it('transfers direct ownership on delegation and rejects forged Lead effects during review', async () => {
    const { parent, coordinator, adapter, workspace, taskId } = await setup([
      toolCallResponse('prepare', shellTool, { command: shellCommand('printf prepared', 'Write-Output prepared'), description: 'Check native shell' }),
      delegate(), edit('forged-lead'),
      toolCallResponse('ptc', 'run_code', { code: shellCommand('await tools.bash({command:"touch ptc-bypass"})', "await tools.pwsh({command:\"[IO.File]::WriteAllText((Join-Path $PWD 'ptc-bypass'),'')\"})") }),
      toolCallResponse('unknown', 'local_effect', {}), review('accept'), textResponse('Verified.'),
    ], [edit(), report()], { ...options, toolMode: 'both' })
    let effects = 0
    parent.ctx.tools.register(defineTool({ name: 'local_effect', description: 'Side effect', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      execute: async () => { effects++; return 'done' } }))
    parent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare, then delegate the correction.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(JSON.stringify(toolResults(parent))).toContain('FUSION_LEAD_READ_ONLY')
    expect(effects).toBe(0)
    expect(() => readFileSync(join(workspace, 'ptc-bypass'))).toThrow()
    const lead = adapter.requests.filter(request => request.model === 'lead')
    expect(lead[0]!.tools!.map(tool => tool.name)).toContain('run_code')
    for (const request of lead.slice(2)) for (const name of [shellTool, 'write', 'run_code', 'local_effect',
      'fusion_delegate', 'fusion_delegate_text', 'fusion_explore', 'fusion_finish_direct', 'fusion_wait']) {
      expect((request.tools ?? []).map(tool => tool.name)).not.toContain(name)
    }
    expect(lead.at(-1)!.tools ?? []).toEqual([])
  })

  it('automatically repairs definite check failures on the same Worker without a Lead relay call', async () => {
    const { parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), review('accept'), textResponse('Verified.'),
    ], [report(), toolCallResponse('restore', 'fusion_read_state', {}), edit(), report('fixed')], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    expect(store.listDocumentIds(`workflow-check-repair:${taskId}:`)).toHaveLength(1)
    expect(adapter.requests.filter(request => request.model === 'lead')).toHaveLength(3)
    expect(adapter.requests.some(request => request.model === 'worker' && JSON.stringify(request.messages).includes('observed these failures'))).toBe(true)
  })

  it('keeps implementation promotion available after a completed exploration', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      explore(), delegate(), review('accept'), textResponse('Verified.'),
    ], [readCalc(), findings(), toolCallResponse('restore-promoted', 'fusion_read_state', {}), edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect, then correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    const lead = adapter.requests.filter(request => request.model === 'lead')
    expect(lead[1]!.tools!.map(tool => tool.name)).toContain('fusion_delegate')
    expect(lead[1]!.tools!.map(tool => tool.name)).toContain('fusion_finish_direct')
    for (const name of ['fusion_explore', 'fusion_delegate_text']) expect(lead[1]!.tools!.map(tool => tool.name)).not.toContain(name)
    expect(lead[2]!.tools!.map(tool => tool.name)).toContain('fusion_review_result')
    expect(lead[2]!.tools!.map(tool => tool.name)).not.toContain('fusion_delegate')
  })

  it('returns a repeated check failure to Lead review after one automatic repair', async () => {
    const { parent, coordinator, store, adapter, taskId } = await setup([
      delegate(), toolCallResponse('decision', 'fusion_review_result', { decision: 'needs-decision', reason: 'The same frozen addition check still fails after the automatic correction attempt.' }), textResponse('The correction is still incomplete.'),
    ], [report(), toolCallResponse('restore', 'fusion_read_state', {}), report('still-failed')], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(store.listDocumentIds(`workflow-check-repair:${taskId}:`)).toHaveLength(1)
    expect(adapter.requests.filter(request => request.model === 'worker')).toHaveLength(3)
    expect(JSON.stringify(toolResults(parent))).toContain('review-ready')
  })

  it('allows the model to replan once before pausing repeated unchanged results', async () => {
    const reads = Array.from({ length: 7 }, (_, i) => toolCallResponse(`read-${i}`, 'read', { file_path: 'calc.py' }))
    const { parent, adapter, store, taskId } = await setup(reads, undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the source.' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(6)
    expect(JSON.stringify(adapter.requests[3]!.messages)).toContain('change the approach')
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('NO_PROGRESS')
    expect(store.listDocumentIds(`workflow-replan:${taskId}:`)).toHaveLength(1)
  })

  it('accepts new user steering after a progress pause without requiring the recovery button', async () => {
    const reads = Array.from({ length: 6 }, (_, i) => toolCallResponse(`read-${i}`, 'read', { file_path: 'calc.py' }))
    const { parent, coordinator, taskId, store } = await setup([...reads, textResponse('It subtracts b from a.')], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the source.' }] }))
    await parent.whenIdle()
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('NO_PROGRESS')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the source already read and explain the defect.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead).toBeUndefined()
  })

  it('resumes an idle Worker through wait only after an explicit local continuation', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      delegate(), toolCallResponse('premature-wait', 'fusion_wait', {}), textResponse('Sidekick needs quota recovery.'),
      toolCallResponse('restore-lead', 'fusion_read_state', {}), toolCallResponse('resume-wait', 'fusion_wait', {}), review('accept'), textResponse('Verified.'),
    ], [providerQuota(), toolCallResponse('restore-worker', 'fusion_read_state', {}), edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Fix addition.' }] }))
    await parent.whenIdle()
    const workerId = coordinator.state(taskId).acceptedChild
    expect(store.listDocumentIds(`workflow-worker-resume:${taskId}:`)).toHaveLength(0)
    const before = readFusionStatus(store, parent.id)
    expect(before.task?.modelControl?.waits.worker?.code).toBe('QUOTA')
    await coordinator.modelControl.continue(parent.id, taskId, before.task!.modelControl!.revision)
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', acceptedChild: workerId })
    expect(store.listDocumentIds(`workflow-worker-resume:${taskId}:`)).toHaveLength(1)
    expect(store.listDocumentIds('child:')).toHaveLength(1)
  })

  it('does not automatically repair a broken acceptance command or pretend it is a code defect', async () => {
    const broken = toolCallResponse('delegate', 'fusion_delegate', { goal: 'Check addition', brief: 'Read and report.',
      allowedPaths: ['calc.py'], checks: [{ command: shellCommand('python3 -c "import sys; sys.exit(127)"', 'exit 127') }] })
    const { parent, store, coordinator, taskId } = await setup([
      broken, toolCallResponse('decision', 'fusion_review_result', { decision: 'needs-decision', reason: 'The acceptance command returned 127, so its executable setup must be corrected.' }), textResponse('The check could not run.'),
    ], [report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check addition.' }] }))
    await parent.whenIdle()
    expect(store.listDocumentIds(`workflow-check-repair:${taskId}:`)).toHaveLength(0)
    expect(JSON.stringify(toolResults(parent))).toContain('checkDefinitionProblem')
    expect(coordinator.state(taskId).phase).not.toBe('COMPLETED')
  })

  it('resumes text delegation after explicit continuation without requiring a workspace lease', async () => {
    const { parent, coordinator, adapter, store, taskId } = await setup([
      toolCallResponse('text', 'fusion_delegate_text', { goal: 'Summarize the supplied sentence', brief: 'Summarize: the library opens at nine.', constraints: [] }),
      textResponse('Sidekick needs quota recovery.'), toolCallResponse('wait', 'fusion_wait', {}), review('accept'), textResponse('Opens at nine.'),
    ], [providerQuota(), toolCallResponse('restore', 'fusion_read_state', {}),
      toolCallResponse('report', 'fusion_submit_result', { summary: 'The library opens at nine.', status: 'completed', unresolved: [] })],
    { ...options, noCwd: true })
    const allowFollowup = holdLeadForFollowup(adapter)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Summarize the supplied sentence.' }] }))
    await parent.whenIdle()
    const workerId = coordinator.state(taskId).acceptedChild
    allowFollowup()
    await coordinator.modelControl.continue(parent.id, taskId, readFusionStatus(store, parent.id).task!.modelControl!.revision)
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', acceptedChild: workerId })
    expect(store.events(taskId).filter(event => event.type === 'lease/acquired')).toHaveLength(0)
  })

  it('finishes after replanning and does not mistake advancing slices for no progress', async () => {
    const reads = Array.from({ length: 3 }, (_, i) => toolCallResponse(`repeat-${i}`, 'read', { file_path: 'calc.py' }))
    const fixture = await setup([...reads, readCalc(), textResponse('Understood.')], undefined, options)
    fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the source.' }] }))
    await fixture.parent.whenIdle()
    expect(fixture.coordinator.state(fixture.taskId).phase).toBe('COMPLETED')
    const slices = Array.from({ length: 35 }, (_, i) => toolCallResponse(`slice-${i}`, 'read', { file_path: 'long.txt', offset: i + 1, limit: 1 }))
    const slicing = await setup([...slices, textResponse('Read all lines.')], undefined, options)
    writeFileSync(join(slicing.workspace, 'long.txt'), Array.from({ length: 35 }, (_, i) => `line ${i}`).join('\n'))
    slicing.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read each line.' }] }))
    await slicing.parent.whenIdle()
    expect(slicing.adapter.requests).toHaveLength(36)
    expect(slicing.coordinator.state(slicing.taskId).phase).toBe('COMPLETED')
  })
})

describe('enforced model workflow', () => {
  const options = { modelLike: true, enforcedWorkflow: true, files: true } as const

  it('answers conversationally without a workspace or Worker', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([textResponse('Hello.')], undefined,
      { modelLike: true, enforcedWorkflow: true, noCwd: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'unverified' })
    expect(coordinator.state(taskId).acceptedChild).toBeUndefined()
  })

  it('cannot accept failed checks and repairs on the same persistent Worker', async () => {
    const { parent, coordinator, store, taskId } = await setup([
      delegate(), review('accept'), review('rework'),
      toolCallResponse('feedback', 'fusion_rework', { feedback: 'The frozen test fails: addition must return a + b. Fix it and report again.' }),
      review('accept'), textResponse('Verified.'),
    ], [report(), edit('before-restore'), toolCallResponse('restore-worker', 'fusion_read_state', {}), edit('after-restore'), report('fixed')], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('Acceptance checks do not prove completion')
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
  })

  it('persists the progress window across coordinator replacement', async () => {
    const { parent, coordinator, ctx, store, taskId } = await setup([], undefined, options)
    const binding = coordinator.bindings.read(parent.id)!.binding
    const exec = { agent: parent, name: 'read', arguments: { file_path: 'calc.py' } } as never
    const result = { isError: false, content: [{ type: 'text', text: 'same file' }] } as never
    expect(coordinator.workflow.observe(exec, result, binding, 'lead', true)).toBe(false)
    expect(coordinator.workflow.observe(exec, result, binding, 'lead', true)).toBe(false)
    await coordinator.close()
    const restored = new FusionCoordinator(ctx, store, coordinator.options)
    cleanups.push(async () => restored.close())
    expect(restored.workflow.observe(exec, result, binding, 'lead', true)).toBe(true)
    expect(restored.state(taskId).control.mode).not.toBe('completed')
  })

  it('hides execution before generation and denies a one-line shell write even with native auto approval', async () => {
    const { parent, coordinator, adapter, taskId, workspace } = await setup([
      edit('forged-lead-write'), delegate(), review('accept'), textResponse('Verified.'),
    ], [edit(), report()], { ...options, toolMode: 'both' })
    parent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('FUSION_LEAD_READ_ONLY')
    for (const request of adapter.requests.filter(request => request.model === 'lead')) {
      const names = request.tools!.map(tool => tool.name)
      for (const name of [shellTool, 'write', 'edit', 'run_code', 'fusion_submit_result']) expect(names).not.toContain(name)
    }
    expect(adapter.requests.find(request => request.model === 'worker')!.tools!.map(tool => tool.name)).toContain(shellTool)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('rejects a forged PTC call and an unclassified agent-local effect', async () => {
    const { parent, ctx, workspace, adapter } = await setup([
      toolCallResponse('ptc', 'run_code', { code: shellCommand('await tools.bash({command:"touch ptc-bypass"})', "await tools.pwsh({command:\"[IO.File]::WriteAllText((Join-Path $PWD 'ptc-bypass'),'')\"})") }),
      toolCallResponse('unknown', 'local_effect', {}), textResponse('Cannot execute.'), textResponse('Still cannot execute.'),
    ], undefined, { ...options, toolMode: 'both' })
    let effects = 0
    parent.ctx.tools.register(defineTool({ name: 'local_effect', description: 'Custom side effect', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
      execute: async () => { effects++; return 'done' } }))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try execution.' }] }))
    await parent.whenIdle()
    expect(effects).toBe(0)
    expect(() => readFileSync(join(workspace, 'ptc-bypass'))).toThrow()
    expect(adapter.requests[0]!.tools!.map(tool => tool.name)).not.toContain('local_effect')
    const ordinary = (await ctx.agents.create({ sessionId: SessionId('ordinary-enforcement'), meta: { cwd: workspace },
      agentOptions: { provider: 'test-native', model: 'ordinary' } })).agent
    expect((await ordinary.ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toContain(shellTool)
  })

  it('cannot acquire a writer by calling takeover before any Worker report', async () => {
    const { parent, coordinator, taskId, workspace } = await setup([
      toolCallResponse('take', 'fusion_takeover', { reason: 'I prefer to do it myself.' }),
      edit('bypass'), textResponse('Done.'), textResponse('Done again.'),
    ], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('FUSION_TAKEOVER_REQUIRES_REWORK')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a - b')
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(coordinator.state(taskId).lease).toBeUndefined()
    expect(coordinator.modelControl.waiting(coordinator.bindings.read(parent.id)!.binding, 'lead')?.code).toBe('WORKFLOW_INCOMPLETE')
  })

  it('permits a reviewed takeover without a line quota and still runs the frozen checks', async () => {
    const content = `${Array.from({ length: 100 }, (_, i) => `# comment ${i}`).join('\n')}\ndef add(a, b):\n    return a + b\n`
    const { parent, coordinator, adapter, taskId, workspace } = await setup([
      delegate(), review('rework'), toolCallResponse('take', 'fusion_takeover', { reason: 'The frozen addition check failed; correct the implementation.' }),
      toolCallResponse('large-correction', 'write', { file_path: 'calc.py', content }), report('lead-report'),
      toolCallResponse('collect', 'fusion_wait', {}), review('accept'), textResponse('Verified correction.'),
    ], [report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(content)
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests.some(request => request.model === 'lead' && request.tools?.some(tool => tool.name === 'write'))).toBe(true)
  })

  it('repairs missing Worker submission and Lead review at the native stop boundary', async () => {
    const { parent, coordinator, adapter, taskId } = await setup([
      delegate(), textResponse('It is finished.'), review('accept'), textResponse('Now verified.'),
    ], [edit(), textResponse('Done.'), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(adapter.requests.some(request => request.model === 'worker' && JSON.stringify(request.messages).includes('Prose alone cannot complete'))).toBe(true)
    expect(adapter.requests.some(request => request.model === 'lead' && JSON.stringify(request.messages).includes('current report has not been accepted'))).toBe(true)
  })

  it('stops after one unsuccessful review repair instead of looping or recording completion', async () => {
    const { parent, coordinator, adapter, taskId, store } = await setup([
      delegate(), textResponse('Done.'), textResponse('Done again.'), textResponse('Must not be called.'),
    ], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(adapter.requests.filter(request => request.model === 'lead')).toHaveLength(3)
    expect(coordinator.state(taskId).control.mode).not.toBe('completed')
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('WORKFLOW_INCOMPLETE')
  })

  it('detects successful repeated reads and stops before another model request', async () => {
    const reads = Array.from({ length: 4 }, (_, i) => toolCallResponse(`read-${i}`, 'read', { file_path: 'calc.py' }))
    const { parent, adapter, store } = await setup(reads, undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read calc.py.' }] }))
    await parent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(readFusionStatus(store, parent.id).task?.modelControl?.waits.lead?.code).toBe('NO_PROGRESS')
  })

  it('allows more than 25 useful reads but stops successive one-line slicing', async () => {
    const reads = Array.from({ length: 30 }, (_, i) => toolCallResponse(`read-${i}`, 'read', { file_path: `file-${i}.txt` }))
    const fixture = await setup([...reads, textResponse('Read the files.')], undefined, options)
    for (let i = 0; i < 30; i++) writeFileSync(join(fixture.workspace, `file-${i}.txt`), `file ${i}\n`)
    fixture.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the files.' }] }))
    await fixture.parent.whenIdle()
    expect(fixture.adapter.requests).toHaveLength(31)
    const tiny = Array.from({ length: 13 }, (_, i) => toolCallResponse(`tiny-${i}`, 'read', { file_path: 'long.txt', offset: i + 1, limit: 1 }))
    const slicing = await setup(tiny, undefined, options)
    writeFileSync(join(slicing.workspace, 'long.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
    slicing.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the file.' }] }))
    await slicing.parent.whenIdle()
    expect(slicing.adapter.requests).toHaveLength(12)
    expect(readFusionStatus(slicing.store, slicing.parent.id).task?.modelControl?.waits.lead?.code).toBe('NO_PROGRESS')
  })
})

describe('enforced-v3 role separation', () => {
  const options = { modelLike: true, enforcedWorkflow: 'enforced-v3', files: true, sandbox: true } as const
  const modes = (session: { snapshotEvents(): { type: string; data: unknown }[] }) =>
    session.snapshotEvents().filter(event => event.type === 'sandbox/mode').map(event => (event.data as { mode: string }).mode)
  const catalog = (request: { tools?: { name: string }[] }) => (request.tools ?? []).map(tool => tool.name)

  it('confines the Lead to read-only tools and a read-only session while the Sidekick keeps the user mode', async () => {
    const { parent, coordinator, adapter, ctx, taskId, workspace } = await setup([delegateV3(), acceptV3(), textResponse('Verified.')], [edit(), report()], options)
    const seen = new Map<string, string[]>()
    cleanups.push(async () => stop())
    const stop = ctx.on('session/event', (session, event) => {
      if (event.type === ('sandbox/mode' as never)) seen.set(session.id, [...seen.get(session.id) ?? [], (event.data as { mode: string }).mode])
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    const lead = adapter.requests.filter(request => request.model === 'lead')
    for (const request of lead.slice(0, 1)) {
      expect(catalog(request)).toEqual(expect.arrayContaining(['read', shellTool, 'fusion_delegate']))
      expect(catalog(request)).not.toEqual(expect.arrayContaining(['write']))
      for (const denied of ['write', 'edit', 'fusion_takeover', 'fusion_submit_result']) expect(catalog(request)).not.toContain(denied)
    }
    // Lead confined before its first request; checks ran under the user mode and re-confined afterwards.
    expect(modes(parent.session)[0]).toBe('read-only')
    expect(modes(parent.session).at(-1)).toBe('read-only')
    expect(modes(parent.session)).toContain('workspace-write')
    // The child is seeded with the Lead's read-only override, then given the user's mode before its first request.
    expect(seen.get(coordinator.state(taskId).acceptedChild!)?.at(-1)).toBe('workspace-write')
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
  })

  it('refuses Lead writes, forged takeover and sandbox escalation, but runs a read-only command', async () => {
    const forged = [
      toolCallResponse('forge-write', 'write', { file_path: 'x.txt', content: 'x' }),
      toolCallResponse('forge-takeover', 'fusion_takeover', { reason: 'fix it myself' }),
      toolCallResponse('escalate', shellTool, { command: 'ls', description: 'list', sandbox_permissions: 'workspace-write', justification: 'need it' }),
      toolCallResponse('inspect', shellTool, { command: 'ls calc.py', description: 'list' }),
    ]
    const { parent, workspace } = await setup([...forged, textResponse('I can only inspect; changes go to the Sidekick.')], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Look at the project.' }] }))
    await parent.whenIdle()
    const results = toolResults(parent).map(result => JSON.stringify(result.message.content))
    expect(results[0]).toContain('FUSION_LEAD_READ_ONLY')
    expect(results[1]).toContain('FUSION_LEAD_READ_ONLY')
    expect(results[2]).toContain('never escalates')
    expect(results[3]).toContain('calc.py')
    expect(results[3]).not.toContain('FUSION_LEAD_READ_ONLY')
    expect(() => readFileSync(join(workspace, 'x.txt'))).toThrow()
  })

  it('refuses the Lead shell when the Host provides no sandbox policy', async () => {
    const { parent } = await setup([toolCallResponse('inspect', shellTool, { command: 'ls', description: 'list' }), textResponse('No shell.')], undefined, { ...options, sandbox: false })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'List files.' }] }))
    await parent.whenIdle()
    expect(JSON.stringify(toolResults(parent))).toContain('exposes no sandbox policy')
  })

  it('treats a user mode switch as the Sidekick mode, keeps the Lead confined, and restores the user mode on exit', async () => {
    const { parent, coordinator } = await setup([textResponse('First.'), textResponse('Second.')], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()
    expect(modes(parent.session).at(-1)).toBe('read-only')
    parent.session.append('sandbox/mode' as never, { mode: 'danger-full-access' } as never)
    await new Promise(resolve => setImmediate(resolve))
    expect(modes(parent.session).at(-1)).toBe('read-only')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Again.' }] }))
    await parent.whenIdle()
    expect(modes(parent.session).at(-1)).toBe('read-only')
    await coordinator.clear(parent)
    expect(modes(parent.session).at(-1)).toBe('danger-full-access')
  })
})

describe('enforced-v3 delegation after Lead inspection', () => {
  const options = { modelLike: true, enforcedWorkflow: 'enforced-v3', files: true, sandbox: true } as const
  it('delegates after a foreground read-only Lead command', async () => {
    const { parent, coordinator, taskId } = await setup([
      toolCallResponse('inspect', shellTool, { command: 'ls', description: 'list' }), delegateV3(), acceptV3(), textResponse('Done.'),
    ], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('refuses a background Lead command so it cannot block the handoff (study failure A)', async () => {
    const { parent, coordinator, taskId } = await setup([
      toolCallResponse('inspect-bg', shellTool, { command: 'sleep 1; ls', description: 'list', run_in_background: true }), delegateV3(), acceptV3(), textResponse('Done.'),
    ], [edit(), report()], { ...options, jobs: true })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    const results = toolResults(parent).map(result => JSON.stringify(result.message.content))
    expect(results[0]).toContain('short foreground inspection commands')
    expect(coordinator.state(taskId), results.join('\n')).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('continues the same Worker from exploration to implementation without a false recovery gate (study failure B)', async () => {
    const { parent, coordinator, taskId, adapter } = await setup([explore(), delegateV3(), acceptV3(), textResponse('Done.')], [findings(), edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find and fix addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(toolResults(parent))).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(JSON.stringify(adapter.requests.filter(request => request.model === 'worker').map(request => request.messages))).not.toContain('Fusion recovery index')
  })

  it('hands the Sidekick the user request verbatim, not only the Lead brief (study failure C)', async () => {
    const issue = 'ISSUE-TEXT: add(2, 3) must return 5; keep test_calc.py unchanged.'
    const { parent, coordinator, taskId, adapter } = await setup([delegateV3(true, ['add(2, 3) must return 5']), acceptV3(), textResponse('Done.')], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: issue }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    const first = adapter.requests.find(request => request.model === 'worker')!
    expect(JSON.stringify(first.messages)).toContain('Original user request')
    expect(JSON.stringify(first.messages)).toContain(issue)
  })
})

/** Two tool calls in one model response (parallel calls in a single step). */
function parallelCalls(...responses: ReturnType<typeof toolCallResponse>[]) {
  const out: ReturnType<typeof toolCallResponse> = []
  responses.forEach((chunks, i) => {
    for (const chunk of chunks) {
      if (chunk.type === 'usage' || chunk.type === 'finish') continue
      out.push({ ...(chunk as object), index: i } as never)
    }
  })
  out.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as never, { type: 'finish', reason: { kind: 'tool-calls' } } as never)
  return out
}

describe('enforced-v3 delegation in the same step as Lead inspection', () => {
  const options = { modelLike: true, enforcedWorkflow: 'enforced-v3', files: true, sandbox: true } as const
  it('replaces an exploration that did not complete instead of dead-ending the task', async () => {
    const { parent, coordinator, taskId, store } = await setup([explore(), delegateV3(), acceptV3(), textResponse('Done.')],
      [textResponse('I looked around.'), textResponse('Still only prose.'), edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find and fix addition.' }] }))
    await parent.whenIdle()
    const results = toolResults(parent).map(result => JSON.stringify(result.message.content))
    expect(coordinator.state(taskId), results.join('\n')).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(store.listDocumentIds('child:')).toHaveLength(1)
    expect(coordinator.state(taskId).currentWorkOrder?.evidence).toEqual([])
  })

  it('lets the Lead redirect a stalled Sidekick at most twice per task and never clears a quota stop', async () => {
    const { parent, coordinator } = await setup([textResponse('Hello.')], undefined, options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()
    const control = coordinator.modelControl, binding = coordinator.bindings.read(parent.id)!.binding
    const stall = (code: string) => {
      const view = readModelControl(control.store, binding)!
      control.write({ ...view, waits: { worker: { taskId: binding.taskId, code, at: new Date().toISOString(), quotaResetAt: null } } })
    }
    stall('QUOTA')
    expect(control.leadRecover(binding, 'worker')).toBe(false)
    expect(control.waiting(binding, 'worker')?.code).toBe('QUOTA')
    for (const code of ['WORKFLOW_INCOMPLETE', 'NO_PROGRESS']) {
      stall(code)
      expect(control.leadRecover(binding, 'worker')).toBe(true)
      expect(control.waiting(binding, 'worker')).toBeUndefined()
    }
    stall('UNKNOWN')
    expect(control.leadRecover(binding, 'worker')).toBe(false)
    expect(control.waiting(binding, 'worker')?.code).toBe('UNKNOWN')
  })

  it('does not refuse a delegation issued alongside a read-only Lead command', async () => {
    const step = parallelCalls(toolCallResponse('inspect', shellTool, { command: 'sleep 1; ls', description: 'list' }), delegateV3())
    const { parent, coordinator, taskId } = await setup([step, acceptV3(), textResponse('Done.')], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    const results = toolResults(parent).map(result => JSON.stringify(result.message.content))
    expect(coordinator.state(taskId), results.join('\n')).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })
})

describe('enforced-v3 daily-driver safeguards (study 2026-09-26)', () => {
  const options = { modelLike: true, enforcedWorkflow: 'enforced-v3', files: true, sandbox: true } as const
  const catalog = (request: { tools?: { name: string }[] }) => (request.tools ?? []).map(tool => tool.name)
  const results = (parent: Awaited<ReturnType<typeof setup>>['parent']) => JSON.stringify(toolResults(parent))
  const withChecks = (checks: unknown[], requirements = ['addition']) => toolCallResponse('delegate', 'fusion_delegate', {
    requirements, goal: 'Correct addition', brief: 'Fix calc.py add. Submit a report after implementing.',
    constraints: [], allowedPaths: ['calc.py'], checks })
  const unit = { id: 'addition', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }
  const suiteScript = process.platform === 'win32' ? 'suite.ps1' : 'suite.sh'
  const suite = { id: 'suite', command: shellCommand('sh suite.sh', 'pwsh -NoProfile -File suite.ps1'), parser: 'pytest', baseline: 'no-new-failures' }

  it('keeps one Lead tool catalog through handoff, review and rework so the prompt cache survives (round 4)', async () => {
    const { parent, coordinator, taskId, adapter } = await setup([delegateV3(), review('rework'),
      toolCallResponse('feedback', 'fusion_rework', { feedback: 'Keep the fix and resubmit.' }), acceptV3('accept-final'), textResponse('Done.')],
    [edit(), report(), report('report-2')], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId).phase, results(parent)).toBe('COMPLETED')
    const catalogs = adapter.requests.filter(request => request.model === 'lead').map(request => JSON.stringify(catalog(request)))
    expect(new Set(catalogs).size, catalogs.join('\n')).toBe(1)
  })

  it('makes the Lead name an existing test the Worker rewrote before accepting (canvasapi)', async () => {
    const checks = [{ id: 'addition', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest' }]
    const handoff = toolCallResponse('delegate', 'fusion_delegate', { requirements: ['addition'], goal: 'Correct addition', brief: 'Fix add.',
      constraints: [], allowedPaths: ['calc.py', 'test_calc.py'], checks })
    const rewrite = toolCallResponse('rewrite', shellTool, { description: 'Fix add and weaken its test', command:
      shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py && sed -i.bak 's/add(2, 3), 5/add(2, 3), add(2, 3)/' test_calc.py && rm test_calc.py.bak", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\"); (Get-Content (Join-Path $PWD 'test_calc.py') -Raw).Replace('add(2, 3), 5','add(2, 3), add(2, 3)') | Set-Content (Join-Path $PWD 'test_calc.py') -NoNewline") })
    const named = toolCallResponse('accept-named', 'fusion_review_result', { decision: 'accept',
      reason: 'test_calc.py assertion changed; confirmed it still asserts add(2, 3) is computed by add, calc.py fixed and unittest passes.',
      requirements: [{ index: 1, met: true, evidence: 'calc.py add returns a + b; test_calc passed natively' }] })
    const { parent, coordinator, taskId } = await setup([handoff, acceptV3(), named, textResponse('Done.')], [rewrite, report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('rewrittenTests')
    expect(results(parent)).toContain('Existing tests lost or changed original lines')
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
  })

  it('does not flag tests that were only extended', async () => {
    const checks = [{ id: 'addition', command: py('python3 -B -m unittest -v test_calc'), kind: 'test', parser: 'unittest' }]
    const handoff = toolCallResponse('delegate', 'fusion_delegate', { requirements: ['addition'], goal: 'Correct addition', brief: 'Fix add.',
      constraints: [], allowedPaths: ['calc.py', 'test_calc.py'], checks })
    const extend = toolCallResponse('extend', shellTool, { description: 'Fix add and add a test', command:
      shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py && printf '    def test_zero(self):\\n        self.assertEqual(add(0, 0), 0)\\n' >> test_calc.py", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\"); [IO.File]::AppendAllText((Join-Path $PWD 'test_calc.py'), \"    def test_zero(self):`n        self.assertEqual(add(0, 0), 0)`n\")") })
    const { parent, coordinator, taskId } = await setup([handoff, acceptV3(), textResponse('Done.')], [extend, report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).not.toContain('rewrittenTests')
    expect(coordinator.state(taskId), results(parent)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
  })

  it('refuses a paraphrased requirement and a v3 handoff without requirements', async () => {
    const { parent } = await setup([delegateV3(true, ['Please repair the add function']), delegateV3(true, []), textResponse('Stopped.')], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('must be exact quotes')
    expect(results(parent)).toContain('needs requirements')
  })

  it('accepts only with one met verdict per user requirement', async () => {
    const { parent, coordinator, taskId, adapter } = await setup([delegateV3(), review('accept'), acceptV3('review-accept-2'), textResponse('Done.')], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('Accept needs one met verdict per user requirement')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(JSON.stringify(adapter.requests.find(request => request.model === 'worker')!.messages)).toContain('Hard requirements')
  })

  it('flags a required literal span missing from every changed file until the review addresses it (loguru)', async () => {
    const quote = 'the docstring must say `Adds two numbers`'
    const spanAware = toolCallResponse('review-accept-3', 'fusion_review_result', { decision: 'accept', reason: 'Addition is fixed; the required docstring literal was checked explicitly.',
      requirements: [{ index: 1, met: true, evidence: 'calc.py: reviewer confirmed the literal Adds two numbers requirement against the diff' }] })
    const { parent, coordinator, taskId } = await setup([delegateV3(true, [quote]), acceptV3(), spanAware, textResponse('Done.')], [edit(), report()], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: `Correct addition; ${quote}.` }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('literalSpansMissing')
    expect(results(parent)).toContain('occurs in no changed file')
    expect(coordinator.state(taskId).phase).toBe('COMPLETED')
  })

  it('passes a regression suite whose only failures already failed on the untouched workspace', async () => {
    const { parent, coordinator, taskId, adapter, workspace } = await setup([withChecks([unit, suite]), acceptV3(), textResponse('Done.')], [edit(), report()], options)
    writeFileSync(join(workspace, suiteScript), shellCommand("if grep -q 'a + b' calc.py; then printf 'FAILED tests/test_legacy.py::test_old - AssertionError\\n1 failed, 5 passed in 0.10s\\n'; else printf 'FAILED tests/test_legacy.py::test_old - AssertionError\\nFAILED tests/test_calc.py::test_add - AssertionError\\n2 failed, 4 passed in 0.10s\\n'; fi; exit 1\n",
      "if (Select-String -Path calc.py -SimpleMatch -Quiet 'a + b') { Write-Output \"FAILED tests/test_legacy.py::test_old - AssertionError`n1 failed, 5 passed in 0.10s\" } else { Write-Output \"FAILED tests/test_legacy.py::test_old - AssertionError`nFAILED tests/test_calc.py::test_add - AssertionError`n2 failed, 4 passed in 0.10s\" }; exit 1"))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(coordinator.state(taskId), results(parent)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(results(parent)).toContain('preExistingFailures')
    expect(JSON.stringify(adapter.requests.find(request => request.model === 'worker')!.messages)).toContain('tests/test_legacy.py::test_old')
  })

  it('refuses acceptance when the regression suite shows a failure the baseline did not have', async () => {
    const { parent, coordinator, taskId, workspace } = await setup([withChecks([unit, suite]), acceptV3(), textResponse('Stopped.')], [edit(), report(), report('report-2')], options)
    writeFileSync(join(workspace, suiteScript), shellCommand("if grep -q 'a + b' calc.py; then printf 'FAILED tests/test_legacy.py::test_old - x\\nFAILED tests/test_other.py::test_new - x\\n2 failed, 4 passed in 0.10s\\n'; else printf 'FAILED tests/test_legacy.py::test_old - x\\n1 failed, 5 passed in 0.10s\\n'; fi; exit 1\n",
      "if (Select-String -Path calc.py -SimpleMatch -Quiet 'a + b') { Write-Output \"FAILED tests/test_legacy.py::test_old - x`nFAILED tests/test_other.py::test_new - x`n2 failed, 4 passed in 0.10s\" } else { Write-Output \"FAILED tests/test_legacy.py::test_old - x`n1 failed, 5 passed in 0.10s\" }; exit 1"))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('Acceptance checks do not prove completion')
    expect(coordinator.state(taskId).phase).not.toBe('COMPLETED')
  })

  it('refuses a baseline it cannot read instead of guessing', async () => {
    const { parent, workspace } = await setup([withChecks([unit, suite]), textResponse('Stopped.')], [edit(), report()], options)
    writeFileSync(join(workspace, suiteScript), shellCommand("printf 'something went wrong\\n'; exit 2\n", "Write-Output 'something went wrong'; exit 2"))
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    expect(results(parent)).toContain('could not be read')
  })

  it('unlocks Lead takeover only after two rework rounds with failing checks, then confines the Lead again', async () => {
    const lead = [
      delegateV3(), review('rework'),
      toolCallResponse('early-take', 'fusion_takeover', { reason: 'I would rather write it myself.' }),
      toolCallResponse('feedback', 'fusion_rework', { feedback: 'calc.py still subtracts; make add return a + b.' }),
      toolCallResponse('review-rework-2', 'fusion_review_result', { decision: 'rework', reason: 'The frozen addition test still fails after a second round; the add body is unchanged.' }),
      toolCallResponse('take', 'fusion_takeover', { reason: 'Two rework rounds left the frozen check failing.' }),
      edit('lead-edit'),
      toolCallResponse('lead-report', 'fusion_submit_result', { summary: 'Lead corrected add in calc.py.', status: 'completed', unresolved: [] }),
      acceptV3('lead-accept'), textResponse('Done.'),
    ]
    const { parent, coordinator, taskId, adapter, store, workspace } = await setup(lead, [report('r1'), report('r2'), report('r3')], options)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Correct addition.' }] }))
    await parent.whenIdle()
    const text = results(parent)
    expect(text).toContain('takeover unlocks only when the Host sees the Sidekick cannot finish')
    expect(coordinator.state(taskId), text).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('a + b')
    const records = store.listDocumentIds(`lead-takeover:${taskId}:`).map(id => store.readDocument(id)!.value as { reason: string; reworkRounds: number })
    expect(records).toMatchObject([{ reason: 'checks-still-failing', reworkRounds: 2 }])
    expect(readHistory(store).takeovers).toEqual({ total: 1, tasks: 1, reasons: { 'checks-still-failing': 1 } })
    const leadRequests = adapter.requests.filter(request => request.model === 'lead')
    expect(catalog(leadRequests[0]!)).not.toContain('fusion_takeover')
    expect(leadRequests.some(request => catalog(request).includes('fusion_submit_result'))).toBe(true)
    expect(catalog(leadRequests.at(-1)!)).not.toContain('fusion_submit_result')
    expect(parent.session.snapshotEvents().filter(event => event.type === 'sandbox/mode').at(-1)?.data).toMatchObject({ mode: 'read-only' })
  })
})
