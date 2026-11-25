import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { MockAdapter, textResponse, toolCallResponse } from '@fusion-host-test/mock-adapter'
import { TestSessionQuery } from '@fusion-host-test/session-query'
import { hostPlugin, mountWorkingDirectory } from './host-plugin.js'
import { mountNativeShell, py, shellCommand, shellTool } from './shell-fixture.js'
import { FusionCoordinator } from '../src/host/coordinator.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { completeProfile } from '../src/profile/resolve.js'
import { loadModelPromptBundle } from '../src/prompts.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('FusionCatalogAdapter Pass 1 -> Pass 2 fidelity and DSH 0.2.2 edge cases', () => {
  it.each(['addition-only', 'in-history'] as const)(
    'preserves dynamic Lead tool updates under toolUpdate=%s without stripping developer tool-addition messages',
    async (toolUpdate) => {
      const root = mkdtempSync(join(tmpdir(), `fusion-tool-update-${toolUpdate}-`))
      const workspace = join(root, 'project')
      mkdirSync(workspace)
      writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n')
      writeFileSync(join(workspace, 'test_calc.py'), 'import unittest\nfrom calc import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')

      const ctx = new Context()
      const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(LocalFileSystem, { cwd: workspace })
      await mountWorkingDirectory(ctx, workspace)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(hostPlugin(JsonlSessionPersistence), { root: join(root, 'sessions') })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TestSessionQuery)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(Spawn, { providerName: 'spawn' })
      const modeOf = (session: { snapshotEvents(): { type: string; data: unknown }[] }) =>
        (session.snapshotEvents().filter(event => event.type === 'sandbox/mode').at(-1)?.data as { mode?: string } | undefined)?.mode
      ctx.provide('sandboxPolicy', {
        overrideOf: modeOf,
        resolve: ({ session }: { session?: Parameters<typeof modeOf>[0] } = {}) =>
          ({ mode: (session && modeOf(session)) ?? 'workspace-write', workspaceRoot: workspace }),
      } as never)
      await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: process.platform === 'win32' ? 15_000 : 5000 })
      await ctx.plugin(ToolFs, {})

      const workerAdapter = new MockAdapter([
        toolCallResponse('r1', 'fusion_submit_result', { summary: 'Attempt 1 unchanged.', status: 'completed', unresolved: [] }),
        toolCallResponse('r2', 'fusion_submit_result', { summary: 'Attempt 2 unchanged.', status: 'completed', unresolved: [] }),
        toolCallResponse('r3', 'fusion_submit_result', { summary: 'Attempt 3 unchanged.', status: 'completed', unresolved: [] }),
      ])
      const leadScript = [
        toolCallResponse('delegate', 'fusion_delegate', {
          goal: 'Correct addition',
          brief: 'Fix calc.py add and preserve test_calc.py.',
          constraints: ['Do not change test_calc.py'],
          requirements: ['addition'],
          allowedPaths: ['calc.py'],
          checks: [{
            id: 'addition',
            description: 'addition passes',
            command: py('python3 -B -m unittest -v test_calc'),
            kind: 'test',
            parser: 'unittest',
            definitionPaths: ['test_calc.py'],
          }],
        }),
        toolCallResponse('review-1', 'fusion_review_result', { decision: 'rework', reason: 'Still subtracting after attempt 1.' }),
        toolCallResponse('rework-1', 'fusion_rework', { feedback: 'Fix calc.py add to return a + b.' }),
        toolCallResponse('review-2', 'fusion_review_result', { decision: 'rework', reason: 'Still subtracting after two rework rounds.' }),
        toolCallResponse('take', 'fusion_takeover', { reason: 'Two rework rounds left checks failing.' }),
        toolCallResponse('lead-write', 'write', { file_path: 'calc.py', content: 'def add(a, b):\n    return a + b\n' }),
        toolCallResponse('lead-submit', 'fusion_submit_result', { summary: 'Lead fixed calc.py.', status: 'completed', unresolved: [] }),
        toolCallResponse('lead-accept', 'fusion_review_result', {
          decision: 'accept',
          reason: 'Lead fixed calc.py and frozen check passed.',
          requirements: [{ index: 1, met: true, evidence: 'calc.py returns a + b; unittest passed' }],
        }),
        textResponse('Done.'),
      ]

      class ToolUpdateAdapter extends MockAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          if (options.model === 'worker') {
            this.requests.push(options)
            yield* workerAdapter.stream(options)
            return
          }
          yield* super.stream(options)
        }
        override async resolveModel(provider: string, model: string) {
          return {
            ...await super.resolveModel(provider, model),
            context: { contextWindow: 128_000 },
            defaultMaxTokens: 8000,
            toolUpdate,
          }
        }
      }

      const adapter = new ToolUpdateAdapter(leadScript)
      ctx.llm.registerAdapter(['test-tu'], adapter)

      const parent = (await ctx.agents.create({
        sessionId: SessionId(`tu-lead-${toolUpdate}`),
        meta: { cwd: workspace },
        agentOptions: { provider: 'test-tu', model: 'ordinary' },
      })).agent
      installModelSelection(parent.ctx)

      const prompts = loadModelPromptBundle()
      const profile = completeProfile({
        id: 'fusion-auto',
        version: 'faithful-v1',
        enabled: true,
        interactionMode: 'model-like',
        workflowPolicy: 'enforced-v3',
        lead: { provider: 'test-tu', model: 'lead' },
        worker: { provider: 'test-tu', model: 'worker' },
        dataPolicyId: 'fixture-only',
      }, prompts)
      const coordinator = new FusionCoordinator(ctx, store, {
        profile: { profile, prompts },
        leaseRoot: join(root, 'leases'),
        workerTools: [shellTool, 'read', 'write', 'edit'],
        authorizeRequest: () => {},
      })
      cleanups.push(async () => {
        await coordinator.close()
        await ctx.fiber.dispose()
        store.close()
        rmSync(root, { recursive: true, force: true })
      })
      await coordinator.select(parent)
      const taskId = coordinator.bindings.read(parent.id)!.binding.taskId

      parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Correct addition.' }] }))
      await parent.whenIdle()

      expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })
      expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')

      // Check the physical Lead request where fusion_takeover unlocked:
      // Pass 2 must have received the real developer `tool-addition` message for
      // deferred dynamically unlocked tools (never stripped by double projection!).
      const leadRequests = adapter.requests.filter(request => request.model === 'lead')
      const takeoverReq = leadRequests.find(req => req.tools?.some(t => t.name === 'fusion_takeover'))
      expect(takeoverReq).toBeTruthy()
      const takeoverTool = takeoverReq!.tools!.find(t => t.name === 'fusion_takeover')!
      if (takeoverTool.deferLoading) {
        const addedNames = takeoverReq!.messages.flatMap(m => m.role === 'developer'
          ? m.content.flatMap(b => b.type === 'tool-addition' ? [b.toolName] : []) : [])
        expect(addedNames).toContain('fusion_takeover')
      }

      const writeReq = leadRequests.find(req => req.tools?.some(t => t.name === 'write'))
      expect(writeReq).toBeTruthy()
      const writeTool = writeReq!.tools!.find(t => t.name === 'write')!
      if (writeTool.deferLoading) {
        const addedNames = writeReq!.messages.flatMap(m => m.role === 'developer'
          ? m.content.flatMap(b => b.type === 'tool-addition' ? [b.toolName] : []) : [])
        expect(addedNames).toContain('write')
        expect(addedNames).toContain('fusion_submit_result')
      }
    },
  )

  it('preserves pre-Fusion replayState when switching an existing session onto Fusion with the same physical Lead adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-replay-'))
    const workspace = join(root, 'project')
    mkdirSync(workspace)
    const ctx = new Context()
    const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectory(ctx, workspace)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(hostPlugin(JsonlSessionPersistence), { root: join(root, 'sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: 5000 })

    class ReplayAdapter extends MockAdapter {
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }
      }
    }
    const adapter = new ReplayAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Pre-fusion answer.' } },
        { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { sig: 'pre-fusion-thinking-token' } } },
      ],
      textResponse('Post-fusion answer.'),
    ])
    ctx.llm.registerAdapter(['test-phys'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('replay-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-phys', model: 'lead' },
    })).agent
    installModelSelection(parent.ctx)

    // Turn 1: ordinary pre-Fusion turn on physical provider `test-phys/lead`.
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello before Fusion.' }] }))
    await parent.whenIdle()

    // Now switch session onto Fusion with the SAME physical Lead adapter (`test-phys/lead`).
    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      interactionMode: 'model-like',
      workflowPolicy: 'enforced-v3',
      lead: { provider: 'test-phys', model: 'lead' },
      worker: { provider: 'test-phys', model: 'worker' },
      dataPolicyId: 'fixture-only',
    }, prompts)
    const coordinator = new FusionCoordinator(ctx, store, {
      profile: { profile, prompts },
      leaseRoot: join(root, 'leases'),
      workerTools: [shellTool],
      authorizeRequest: () => {},
    })
    cleanups.push(async () => {
      await coordinator.close()
      await ctx.fiber.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    })
    await coordinator.select(parent)

    // Turn 2: Fusion turn — pre-Fusion assistant message must retain its replayState!
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'What is 1 + 1?' }] }))
    await parent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const forwardedAssistant = adapter.requests[1]!.messages.find(m => m.role === 'assistant')
    expect(forwardedAssistant).toBeTruthy()
    expect(forwardedAssistant?.role === 'assistant' ? forwardedAssistant.source.replayState : undefined).toEqual({
      response: { sig: 'pre-fusion-thinking-token' },
    })
  })

  it('stops immediately on ACCOUNT_QUOTA even under retryPolicy mode=always', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-account-quota-'))
    const workspace = join(root, 'project')
    mkdirSync(workspace)
    const ctx = new Context()
    const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectory(ctx, workspace)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(hostPlugin(JsonlSessionPersistence), { root: join(root, 'sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LlmRetry)
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: 5000 })

    class AlwaysRetryQuotaAdapter extends MockAdapter {
      override providerRetryPolicy() {
        return resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'fixture')
      }
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }
      }
    }
    const adapter = new AlwaysRetryQuotaAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_QUOTA', message: 'DeepSeek account quota reached' } } }],
      textResponse('Must not retry ACCOUNT_QUOTA'),
    ])
    ctx.llm.registerAdapter(['test-acct'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('acct-quota-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-acct', model: 'ordinary' },
    })).agent
    installModelSelection(parent.ctx)

    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      interactionMode: 'model-like',
      workflowPolicy: 'enforced-v3',
      lead: { provider: 'test-acct', model: 'lead' },
      worker: { provider: 'test-acct', model: 'worker' },
      dataPolicyId: 'fixture-only',
    }, prompts)
    const coordinator = new FusionCoordinator(ctx, store, {
      profile: { profile, prompts },
      leaseRoot: join(root, 'leases'),
      workerTools: [shellTool],
      authorizeRequest: () => {},
    })
    cleanups.push(async () => {
      await coordinator.close()
      await ctx.fiber.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    })
    await coordinator.select(parent)

    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello.' }] }))
    await parent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const binding = coordinator.bindings.read(parent.id)!.binding
    expect(coordinator.modelControl.waiting(binding, 'lead')?.code).toBe('ACCOUNT_QUOTA')
  })

  it('rejects Worker run_in_background when job_output/job_kill are restricted out of workerTools despite global registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-bg-scope-'))
    const workspace = join(root, 'project')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n')

    const ctx = new Context()
    const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectory(ctx, workspace)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(hostPlugin(JsonlSessionPersistence), { root: join(root, 'sessions') })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    // Mount jobs globally (so job_output & job_kill exist in global registry)...
    await mountNativeShell(ctx, { dshHome: join(root, 'home'), timeoutMs: 5000, jobs: true })

    const workerAdapter = new MockAdapter([
      toolCallResponse('bg-try', shellTool, { command: shellCommand('echo hi', 'Write-Output hi'), description: 'try background', run_in_background: true }),
      toolCallResponse('submit', 'fusion_submit_result', { summary: 'Background denied cleanly.', status: 'completed', unresolved: [] }),
    ])
    class RoutingAdapter extends MockAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.model === 'worker') {
          this.requests.push(options)
          yield* workerAdapter.stream(options)
          return
        }
        yield* super.stream(options)
      }
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }
      }
    }
    const adapter = new RoutingAdapter([
      toolCallResponse('delegate', 'fusion_delegate', {
        goal: 'Try background command',
        brief: 'Attempt a background shell command.',
        constraints: [],
        allowedPaths: ['calc.py'],
        checks: [],
      }),
      toolCallResponse('accept', 'fusion_review_result', { decision: 'accept', reason: 'Verified background denial cleanly.' }),
      textResponse('Done.'),
    ])
    ctx.llm.registerAdapter(['test-bg'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('bg-scope-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-bg', model: 'ordinary' },
    })).agent
    installModelSelection(parent.ctx)

    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      lead: { provider: 'test-bg', model: 'lead' },
      worker: { provider: 'test-bg', model: 'worker' },
      dataPolicyId: 'fixture-only',
    }, prompts)
    // ...but omit job_output and job_kill from workerTools!
    const coordinator = new FusionCoordinator(ctx, store, {
      profile: { profile, prompts },
      leaseRoot: join(root, 'leases'),
      workerTools: [shellTool],
      authorizeRequest: () => {},
    })
    cleanups.push(async () => {
      await coordinator.close()
      await ctx.fiber.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    })
    await coordinator.select(parent)

    const workerToolResults: string[] = []
    ctx.on('session/event', (session: { header: { parentSession?: string } }, event: { type: string }) => {
      if (event.type === 'tool/result' && session.header.parentSession) workerToolResults.push(JSON.stringify(event))
    })

    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run check.' }] }))
    await parent.whenIdle()

    expect(workerToolResults.some(row => row.includes('Background commands require the native jobs runtime and visible job_output/job_kill tools'))).toBe(true)
  })
})
