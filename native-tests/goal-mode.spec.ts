import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
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

describe('Goal mode + Fusion integration (Issue #23)', () => {
  it('explores, delegates, verifies, accepts, and completes a real DSH Goal round without human user/message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-goal-'))
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
    await ctx.plugin(GoalService)
    await ctx.plugin(ToolGoal, {})
    await ctx.plugin(GoalRoundDriver)

    const workerAdapter = new MockAdapter([
      toolCallResponse('read-calc', 'read', { file_path: 'calc.py' }),
      toolCallResponse('findings', 'fusion_submit_result', {
        status: 'completed',
        summary: 'calc.py subtracts instead of adding.',
        unresolved: [],
        sources: [{ path: 'calc.py', startLine: 1, endLine: 2 }],
      }),
      toolCallResponse('edit-calc', shellTool, {
        command: shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\")"),
        description: 'Fix add in calc.py',
      }),
      toolCallResponse('report', 'fusion_submit_result', {
        summary: 'Fixed add in calc.py to return a + b.',
        status: 'completed',
        unresolved: [],
      }),
    ])

    let createdGoalId = ''
    let createdGoalRevision = 1
    const leadScript: ConstructorParameters<typeof MockAdapter>[0] = [
      toolCallResponse('explore', 'fusion_explore', {
        goal: 'Inspect calc.py',
        brief: 'Read calc.py and locate the addition bug.',
        constraints: ['Do not modify files'],
      }),
      toolCallResponse('delegate', 'fusion_delegate', {
        goal: 'Fix addition in calc.py',
        brief: 'Change a - b to a + b in calc.py and keep test_calc.py unchanged.',
        constraints: ['Preserve test_calc.py'],
        requirements: ['Fix addition in calc.py'],
        allowedPaths: ['calc.py'],
        checks: [{
          id: 'addition',
          description: 'test_calc passes',
          command: py('python3 -B -m unittest -v test_calc'),
          kind: 'test',
          parser: 'unittest',
          definitionPaths: ['test_calc.py'],
        }],
      }),
      toolCallResponse('review-accept', 'fusion_review_result', {
        decision: 'accept',
        reason: 'calc.py now returns a + b and the frozen unittest suite passed.',
        requirements: [{ index: 1, met: true, evidence: 'calc.py line 2 returns a + b; test_calc passed' }],
      }),
      toolCallResponse('read-goal', 'get_goal', {}),
      // Step 5 dynamically calls update_goal using the created goal id/revision (injected below).
      textResponse('Goal completed and verified.'),
      textResponse('Wrapped up cleanly.'),
    ]

    let leadStep = 0
    class RoutingAdapter extends MockAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.model === 'worker') {
          this.requests.push(options)
          yield* workerAdapter.stream(options)
          return
        }
        leadStep++
        if (leadStep === 5) {
          this.requests.push(options)
          yield* toolCallResponse('complete-goal', 'update_goal', {
            goal_id: createdGoalId,
            revision: createdGoalRevision,
            action: 'complete',
          })
          return
        }
        yield* super.stream(options)
      }
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }
      }
    }

    const adapter = new RoutingAdapter(leadScript)
    ctx.llm.registerAdapter(['test-goal'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('goal-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-goal', model: 'ordinary' },
    })).agent
    installModelSelection(parent.ctx)

    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      interactionMode: 'model-like',
      workflowPolicy: 'enforced-v3',
      lead: { provider: 'test-goal', model: 'lead' },
      worker: { provider: 'test-goal', model: 'worker' },
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

    // Create a Goal directly (triggers GoalRoundDriver automatic round 1 with source.kind === 'goal').
    const created = ctx.goals.create(parent, { objective: 'Fix addition in calc.py and verify with test_calc.' })
    createdGoalId = created.id
    createdGoalRevision = created.revision

    await vi.waitFor(
      () => expect(ctx.goals.get(parent)?.phase).toBe('complete'),
      { timeout: process.platform === 'win32' ? 15_000 : 10_000 },
    )
    await parent.whenIdle()

    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(coordinator.state(taskId)).toMatchObject({ phase: 'COMPLETED', verification: 'verified' })

    const results = parent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(JSON.stringify(results)).not.toContain('No native user instruction source')
    expect(results.every(message => !message.isError)).toBe(true)

    // Verify Goal tools are exposed to Lead and NEVER exposed to Sidekick.
    const leadTools = adapter.requests.find(request => request.model === 'lead')?.tools?.map(tool => tool.name) ?? []
    expect(leadTools).toContain('get_goal')
    expect(leadTools).toContain('update_goal')
    const workerRequests = adapter.requests.filter(request => request.model === 'worker')
    expect(workerRequests.length).toBeGreaterThan(0)
    for (const req of workerRequests) {
      const names = req.tools?.map(tool => tool.name) ?? []
      expect(names).not.toContain('get_goal')
      expect(names).not.toContain('create_goal')
      expect(names).not.toContain('update_goal')
    }
  })

  it('does not let an automatic goal round clear a human quota-exhausted wait', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-goal-quota-'))
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
    await ctx.plugin(GoalService)
    await ctx.plugin(GoalRoundDriver)

    class QuotaAdapter extends MockAdapter {
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 } }
      }
    }
    const adapter = new QuotaAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'Quota exhausted' } } }],
      textResponse('Must not run automatically on goal round'),
    ])
    ctx.llm.registerAdapter(['test-goal-quota'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('goal-quota-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-goal-quota', model: 'ordinary' },
    })).agent
    installModelSelection(parent.ctx)

    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      interactionMode: 'model-like',
      workflowPolicy: 'enforced-v3',
      lead: { provider: 'test-goal-quota', model: 'lead' },
      worker: { provider: 'test-goal-quota', model: 'worker' },
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

    ctx.goals.create(parent, { objective: 'Keep trying despite quota.' })
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1), { timeout: 5000 })
    await parent.whenIdle()
    const binding = coordinator.bindings.read(parent.id)!.binding
    expect(coordinator.modelControl.waiting(binding, 'lead')?.code).toBe('QUOTA')
    // No second automatic attempt is admitted while quota wait is active.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adapter.requests).toHaveLength(1)
  })

  it('carries Turn 1 human requirements across multi-round Goal rollovers and completes final wrap-up rounds cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fusion-goal-multi-'))
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
    await ctx.plugin(GoalService)
    await ctx.plugin(ToolGoal, {})
    await ctx.plugin(GoalRoundDriver)

    const workerAdapter = new MockAdapter([
      // Stage 1 (Turn 1): fix calc.py
      toolCallResponse('edit-calc', shellTool, {
        command: shellCommand("printf 'def add(a, b):\\n    return a + b\\n' > calc.py", "[IO.File]::WriteAllText((Join-Path $PWD 'calc.py'), \"def add(a, b):`n    return a + b`n\")"),
        description: 'Fix add in calc.py',
      }),
      toolCallResponse('report-1', 'fusion_submit_result', {
        summary: 'Fixed calc.py add to return a + b.',
        status: 'completed',
        unresolved: [],
      }),
      // Stage 2 (Goal Round 1): add greet.py
      toolCallResponse('edit-greet', shellTool, {
        command: shellCommand("printf 'def greet():\\n    return \"hello\"\\n' > greet.py", "[IO.File]::WriteAllText((Join-Path $PWD 'greet.py'), \"def greet():`n    return 'hello'`n\")"),
        description: 'Add greet helper',
      }),
      toolCallResponse('report-2', 'fusion_submit_result', {
        summary: 'Added greet.py returning hello.',
        status: 'completed',
        unresolved: [],
      }),
    ])

    let goalId = ''
    let goalRevision = 1
    let leadStep = 0
    const leadScript: ConstructorParameters<typeof MockAdapter>[0] = [
      // Turn 1 (human user/message): create_goal, delegate stage 1, accept stage 1, end turn 1
      toolCallResponse('mk-goal', 'create_goal', { objective: 'Fix calc.py and implement greet.py.' }),
      toolCallResponse('delegate-1', 'fusion_delegate', {
        goal: 'Fix addition in calc.py',
        brief: 'Change a - b to a + b in calc.py.',
        constraints: ['Preserve test_calc.py'],
        requirements: ['fix add in calc.py'],
        allowedPaths: ['calc.py'],
        checks: [{
          id: 'addition',
          description: 'test_calc passes',
          command: py('python3 -B -m unittest -v test_calc'),
          kind: 'test',
          parser: 'unittest',
          definitionPaths: ['test_calc.py'],
        }],
      }),
      toolCallResponse('accept-1', 'fusion_review_result', {
        decision: 'accept',
        reason: 'calc.py now adds a + b and test_calc passed.',
        requirements: [{ index: 1, met: true, evidence: 'calc.py line 2 returns a + b; test_calc passed' }],
      }),
      textResponse('Stage 1 complete; continuing to Stage 2 in next goal round.'),
      // Goal Round 1 (source.kind === 'goal'): rollover Task 2, delegate quoting Turn 1's human words verbatim!
      toolCallResponse('delegate-2', 'fusion_delegate', {
        goal: 'Implement greet helper',
        brief: 'Create greet.py with def greet() returning hello.',
        constraints: ['Keep calc.py untouched'],
        requirements: ['create greet.py with exact helper greet()'],
        allowedPaths: ['greet.py'],
        checks: [{
          id: 'greet',
          description: 'greet() returns hello',
          command: py('python3 -c "import greet; assert greet.greet() == \'hello\'"'),
          kind: 'static-check',
          parser: 'exit-code',
        }],
      }),
      toolCallResponse('accept-2', 'fusion_review_result', {
        decision: 'accept',
        reason: 'greet.py defines greet() returning hello and check passed.',
        requirements: [{ index: 1, met: true, evidence: 'greet.py defines greet() returning hello; check passed' }],
      }),
      textResponse('Stage 2 complete; final verification in next round.'),
      // Goal Round 2 (source.kind === 'goal'): rollover Task 3, read-only inspect + update_goal(complete)
      toolCallResponse('inspect-greet', 'read', { file_path: 'greet.py' }),
      // Step 9 dynamically calls update_goal(complete) below
      textResponse('All goal stages verified and complete.'),
    ]

    class MultiRoundAdapter extends MockAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.model === 'worker') {
          this.requests.push(options)
          yield* workerAdapter.stream(options)
          return
        }
        leadStep++
        if (leadStep === 9) {
          this.requests.push(options)
          const currentGoal = ctx.goals.get(parent)!
          goalId = currentGoal.id
          goalRevision = currentGoal.revision
          yield* toolCallResponse('finish-goal', 'update_goal', {
            goal_id: goalId,
            revision: goalRevision,
            action: 'complete',
          })
          return
        }
        yield* super.stream(options)
      }
      override async resolveModel(provider: string, model: string) {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 }, defaultMaxTokens: 8000 }
      }
    }

    const adapter = new MultiRoundAdapter(leadScript)
    ctx.llm.registerAdapter(['test-goal-multi'], adapter)

    const parent = (await ctx.agents.create({
      sessionId: SessionId('goal-multi-lead'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'test-goal-multi', model: 'ordinary' },
    })).agent
    installModelSelection(parent.ctx)

    const prompts = loadModelPromptBundle()
    const profile = completeProfile({
      id: 'fusion-auto',
      version: 'faithful-v1',
      enabled: true,
      interactionMode: 'model-like',
      workflowPolicy: 'enforced-v3',
      lead: { provider: 'test-goal-multi', model: 'lead' },
      worker: { provider: 'test-goal-multi', model: 'worker' },
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

    parent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Please fix add in calc.py and create greet.py with exact helper greet().' }],
    }))

    await vi.waitFor(
      () => expect(ctx.goals.get(parent)?.phase).toBe('complete'),
      { timeout: process.platform === 'win32' ? 15_000 : 10_000 },
    )
    await parent.whenIdle()

    // Every tool call across Turn 1, Goal Round 1, and Goal Round 2 succeeded without verbatim-quote failure.
    const results = parent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results.every(message => !message.isError), JSON.stringify(results)).toBe(true)

    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toContain('return a + b')
    expect(readFileSync(join(workspace, 'greet.py'), 'utf8')).toContain('def greet():')

    // The final wrap-up Task 3 (Goal Round 2) must transition to COMPLETED rather than staying stuck in READY.
    const finalBinding = coordinator.bindings.read(parent.id)!.binding
    expect(coordinator.state(finalBinding.taskId)).toMatchObject({ phase: 'COMPLETED', control: { mode: 'completed' } })
  })
})
