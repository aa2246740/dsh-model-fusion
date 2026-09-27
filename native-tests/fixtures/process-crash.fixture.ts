import { expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '@fusion-host-test/mock-adapter'
import { TestSessionQuery } from '@fusion-host-test/session-query'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { FusionCoordinator } from '../../src/host/coordinator.js'
import { SqliteFusionStore } from '../../src/task/sqlite-store.js'
import { completeProfile } from '../../src/profile/resolve.js'
import { loadPromptBundle } from '../../src/prompts.js'

const root = process.env.FUSION_CRASH_ROOT!, phase = process.env.FUSION_CRASH_PHASE!, kind = process.env.FUSION_CRASH_KIND!
const constraint = 'Keep the public test unchanged. Preserve DO_NOT_DROP_CRASH_CONSTRAINT in the task facts.'
const takeover = () => toolCallResponse('takeover', 'fusion_takeover', { reason: 'Apply the small inspected correction directly' })
const edit = () => toolCallResponse('edit', 'bash', { command: "printf 'def add(a, b):\\n    return a + b\\n' > calc.py; printf '# effect\\n' >> effects.txt", description: 'Apply one correction and count the effect' })
const running = () => toolCallResponse('running-command', 'bash', { command: 'python3 -B run_until_stopped.py', description: 'Wait in the owned process fixture before applying an effect', timeoutMs: 60_000 })
const delegate = () => toolCallResponse('delegate', 'fusion_delegate', {
  goal: 'Fix addition', brief: 'Correct calc.py and report the candidate. Keep the public test unchanged.',
  constraints: [constraint], allowedPaths: ['calc.py', 'effects.txt', 'running-command.json', 'heartbeat.txt'],
  checks: [{ id: 'addition', description: 'Original public test passes', command: 'python3 -B -m unittest -v test_calc',
    kind: 'test', parser: 'unittest', definitionPaths: ['test_calc.py'] }],
})
const report = () => toolCallResponse('report', 'fusion_submit_result', { summary: 'The inspected addition fix is present.', status: 'completed', unresolved: [] })
const review = () => toolCallResponse('review', 'fusion_review_result', { decision: 'accept', reason: 'The unchanged public test passes on the inspected candidate.' })
const send = (agent: Awaited<ReturnType<Context['agents']['create']>>['agent'], text: string) =>
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

function receipt(value: object): void {
  const file = join(root, `${phase}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, ...value }))
  renameSync(`${file}.tmp`, file)
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!check()) { if (Date.now() > deadline) throw new Error('Crash point was not reached'); await delay(20) }
}

it('runs only inside its owned crash harness', async () => {
  if (!root || !['crash', 'inspect', 'observe', 'recover'].includes(phase) || !['approval', 'worker-effect', 'compaction', 'live-command'].includes(kind)) throw new Error('Invalid crash fixture environment')
  const workspace = join(root, 'project'), ctx = new Context()
  if (phase === 'crash') {
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n')
    writeFileSync(join(workspace, 'test_calc.py'), 'import unittest\nfrom calc import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
    writeFileSync(join(workspace, 'effects.txt'), '')
    if (kind === 'live-command') writeFileSync(join(workspace, 'run_until_stopped.py'), [
      'import json, os, time', 'from pathlib import Path',
      "Path('running-command.json').write_text(json.dumps({'pid': os.getpid(), 'pgid': os.getpgid(0)}))",
      'deadline = time.monotonic() + 45', 'count = 0',
      'while time.monotonic() < deadline:',
      "    Path('heartbeat.txt').write_text(str(count))", '    count += 1', '    time.sleep(0.05)',
      "raise SystemExit('Fixture self-termination deadline reached without applying an effect')", '',
    ].join('\n'))
  }
  const store = new SqliteFusionStore(join(root, 'fusion.sqlite'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv, { dshHome: join(root, 'home') })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 5000 })
  await ctx.plugin(ToolBash, { enableRunInBackground: false })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  if (kind === 'compaction') await ctx.plugin(BasicCompaction, { auto: false, maxTokens: 512 })
  const script: ConstructorParameters<typeof MockAdapter>[0] = ['inspect', 'observe'].includes(phase) ? [] : phase === 'crash'
    ? kind === 'approval' ? [takeover(), edit()]
      : kind === 'worker-effect' ? [delegate(), edit(), 'hang']
        : kind === 'live-command' ? [delegate(), running()]
        : [textResponse('Old exploration detail. '.repeat(8000)).filter(chunk => chunk.type !== 'usage'), 'hang']
    : kind === 'approval' ? [takeover(), edit(), toolCallResponse('finish', 'fusion_finish_direct', {}), textResponse('Done')]
      : kind === 'worker-effect' ? [toolCallResponse('rework', 'fusion_rework', { feedback: 'The old process stopped after the edit. I inspected the correct file and one effect. Do not repeat the edit; submit the existing candidate.' }), report(), review(), textResponse('Verified')]
        : kind === 'live-command' ? [toolCallResponse('rework', 'fusion_rework', { feedback: 'The interrupted command has been stopped and inspected. Apply the addition correction once, then submit the candidate.' }), edit(), report(), review(), textResponse('Verified')]
        : [textResponse('Earlier exploration compacted.'), textResponse('Resumed after inspection.')]
  class ContextAdapter extends MockAdapter {
    override async resolveModel(provider: string, model: string) {
      return { ...await super.resolveModel(provider, model), context: { contextWindow: 128_000 } }
    }
  }
  const adapter = new ContextAdapter(script)
  ctx.llm.registerAdapter(['test-crash'], adapter)
  const parent = (phase === 'crash'
    ? await ctx.agents.create({ sessionId: SessionId('lead'), meta: { cwd: workspace }, agentOptions: { provider: 'test-crash', model: 'lead' } })
    : await ctx.agents.resume({ resumeSessionId: SessionId('lead'), agentOptions: { provider: 'test-crash', model: 'lead' } })).agent
  installModelSelection(parent.ctx, { current: { provider: 'test-crash', model: 'lead' }, assembled: undefined })
  const prompts = loadPromptBundle()
  const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
    lead: { provider: 'test-crash', model: 'lead' }, worker: { provider: 'test-crash', model: 'worker' }, dataPolicyId: 'fixture-only',
    // Force compaction at the intended crash point, independently of production defaults.
    ...(kind === 'compaction' ? { context: { lead: { targetInputTokens: 32_000 } } } : {}),
  }, prompts)
  const coordinator = new FusionCoordinator(ctx, store, { profile: { profile, prompts }, leaseRoot: join(root, 'leases'),
    workerTools: ['bash'], authorizeRequest: () => { /* Only the local scripted adapter exists. */ } })
  try {
    if (phase === 'crash' && kind === 'compaction') {
      send(parent, 'Explore this project before the task.')
      await parent.whenIdle()
    }
    if (phase === 'crash') await coordinator.select(parent)
    const taskId = coordinator.bindings.read(parent.id)!.binding.taskId
    let answer!: (outcome: ApprovalOutcome) => void
    let asked = false
    if (kind === 'approval') {
      ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'bash' ? { kind: 'ask', reason: 'Fixture approval' } : next())
      ctx.on('approval/request', async () => { asked = true; return new Promise<ApprovalOutcome>(resolve => { answer = resolve }) })
    }
    if (phase === 'crash') {
      send(parent, constraint)
      await until(() => kind === 'approval' ? asked : kind === 'worker-effect' ? adapter.requests.length === 3
        : kind === 'live-command' ? existsSync(join(workspace, 'heartbeat.txt')) : adapter.requests.some(request => request.purpose === 'compaction'))
      for (const agent of ctx.agents.list()) expect(await ctx.sessions.flush(agent.session)).toBe(true)
      const state = coordinator.state(taskId)
      const oldApproval = Object.values(state.pendingApprovals)[0]
      receipt({ point: kind, taskId, childId: state.acceptedChild, oldApproval,
        command: kind === 'live-command' ? JSON.parse(readFileSync(join(workspace, 'running-command.json'), 'utf8')) : undefined,
        requestCount: adapter.requests.length, state, originalConstraint: constraint })
      await new Promise<void>(() => {}) // parent verifies PID, then sends SIGKILL
      return
    }
    const stopped = JSON.parse(readFileSync(join(root, 'terminated.json'), 'utf8'))
    expect(() => process.kill(stopped.pid, 0)).toThrow()
    const inspected = existsSync(join(root, 'inspect.json'))
    expect(coordinator.state(taskId).control.recovering).toBe(!inspected)
    if (!inspected) await expect(coordinator.resume(parent, 'fixture-no-spend')).rejects.toThrow('recover')
    expect(adapter.requests).toHaveLength(0)
    expect(JSON.stringify(parent.session.snapshotEvents())).toContain(constraint)
    expect(readFileSync(join(workspace, 'effects.txt'), 'utf8')).toBe(kind === 'worker-effect' ? '# effect\n' : '')
    if (kind === 'live-command') {
      expect(coordinator.effects.pending(taskId)).toHaveLength(1)
      await expect(coordinator.reconcile(parent, { commandId: 'insufficient-inspection', note: 'The old Host process is dead and the workspace was inspected.' })).rejects.toThrow('--effects-stopped')
      expect(adapter.requests).toHaveLength(0)
      if (phase === 'observe') {
        process.kill(stopped.command.pid, 0)
        receipt({ point: kind, taskId, childId: coordinator.state(taskId).acceptedChild,
          state: coordinator.state(taskId), requestCount: 0, liveCommandVerified: true, genericRecoveryRejected: true })
        return
      }
      expect(existsSync(join(root, 'command-stopped.json'))).toBe(true)
      expect(() => process.kill(stopped.command.pid, 0)).toThrow()
    }
    if (!inspected) await coordinator.reconcile(parent, { commandId: 'native-process-inspection',
      effectsStopped: kind === 'live-command', note: 'Inspected the workspace, stopped command and its descendants, native session and effect count; no old execution remains live.' })
    if (kind === 'live-command') {
      expect(coordinator.effects.pending(taskId)).toHaveLength(0)
      const records = store.listDocumentIds(`native-effect:${taskId}:`).map(id => store.readDocument(id)!.value)
      expect(records).toMatchObject([{ state: 'inspected', quiescenceBasis: 'explicit-user-inspection', inspectionEvidence: expect.any(String) }])
      expect(records[0]).not.toHaveProperty('nativeIsError')
    }
    expect(coordinator.state(taskId).control).toMatchObject({ mode: 'paused', recovering: false, pendingApprovalIds: [] })
    if (phase === 'inspect') {
      expect(store.listDocumentIds(`context-recovery:${taskId}:`).map(id => store.readDocument(id)!.value)).toMatchObject([
        { state: 'inspected-after-interruption', inspectionEvidence: expect.any(String) },
      ])
      receipt({ point: kind, taskId, state: coordinator.state(taskId), requestCount: adapter.requests.length })
      return
    }
    await coordinator.resume(parent, 'fixture-no-spend')
    send(parent, 'Continue the inspected task without repeating an already completed effect.')
    if (kind === 'approval') {
      await until(() => asked)
      const renewed = Object.values(coordinator.state(taskId).pendingApprovals)[0]!
      expect(renewed.id).toBe(stopped.oldApproval.id)
      expect(renewed.nativeRequestId).not.toBe(stopped.oldApproval.nativeRequestId)
      expect(readFileSync(join(workspace, 'effects.txt'), 'utf8')).toBe('')
      answer('allowed-once')
    }
    await parent.whenIdle()
    expect(coordinator.state(taskId), JSON.stringify(parent.session.snapshotEvents().slice(-10))).toMatchObject({ phase: 'COMPLETED', control: { recovering: false } })
    if (kind === 'worker-effect' || kind === 'live-command') {
      expect(coordinator.state(taskId)).toMatchObject({ acceptedChild: stopped.childId, verification: 'verified' })
      const worker = adapter.requests.find(request => request.model === 'worker')!
      expect(JSON.stringify(worker.messages)).toContain(kind === 'worker-effect' ? 'Apply one correction and count the effect' : 'run_until_stopped.py')
      expect(JSON.stringify(worker.messages)).toContain(kind === 'worker-effect' ? 'Do not repeat the edit' : 'Apply the addition correction once')
    }
    expect(readFileSync(join(workspace, 'effects.txt'), 'utf8')).toBe(kind === 'compaction' ? '' : '# effect\n')
    expect(adapter.requests.length).toBeGreaterThan(0)
    const resumed = adapter.requests.filter(request => request.purpose === undefined)
    expect(resumed.length).toBeGreaterThan(0)
    expect(JSON.stringify(resumed[0]!.messages)).toContain(constraint)
    receipt({ point: kind, taskId, childId: coordinator.state(taskId).acceptedChild,
      requestCount: adapter.requests.length, state: coordinator.state(taskId),
      originalConstraintPreserved: true, originalTestSha256: (await import('node:crypto')).createHash('sha256').update(readFileSync(join(workspace, 'test_calc.py'))).digest('hex'),
      effectCount: readFileSync(join(workspace, 'effects.txt'), 'utf8').split('\n').filter(Boolean).length })
  } finally { await coordinator.close(); await ctx.fiber.dispose(); store.close() }
})
