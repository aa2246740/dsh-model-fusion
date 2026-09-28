import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { MockAdapter } from '@fusion-host-test/mock-adapter'
import { NativeRoleSandbox } from '../src/host/native-role-sandbox.js'
import type { SessionBinding } from '../src/host/bindings.js'
import { completeProfile } from '../src/profile/resolve.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { TaskId } from '../src/contracts.js'

// Windows is the only skip condition. Missing pwsh, ACL support, or native
// prerequisites on Windows must fail this acceptance test visibly.
describe.skipIf(process.platform !== 'win32')('Fusion roles over real Windows ACL confinement', () => {
  it('denies the Lead Set-Content probe and allows the same write for the Sidekick', async () => {
    const root = mkdtempSync(join(homedir(), 'fusion-readonly-e2e-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const ctx = new Context()
    const store = new SqliteFusionStore(':memory:')
    const handles: Awaited<ReturnType<Context['agents']['create']>>[] = []
    try {
      // This public testkit includes SessionProjectionRegistry, required by
      // rc.2 SandboxPolicyService before the executor can be registered.
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ShellEnv, { dshHome: join(root, 'home') })
      await ctx.plugin(LocalSandboxProvider, {})
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
      await ctx.plugin(SandboxPwshExecutor, { timeoutMs: 30_000 })
      await ctx.plugin(ToolPwsh, { enableRunInBackground: false, promoteOnTimeout: false })
      const adapter = new MockAdapter([])
      ctx.llm.registerAdapter(['test-readonly'], adapter)
      const leadHandle = await ctx.agents.create({ sessionId: SessionId('lead'), meta: { cwd: workspace },
        agentOptions: { provider: 'test-readonly', model: 'lead' } })
      handles.push(leadHandle)
      const workerHandle = await ctx.agents.create({ sessionId: SessionId('worker'),
        meta: { cwd: workspace, parentSession: leadHandle.agent.id },
        agentOptions: { provider: 'test-readonly', model: 'worker' } })
      handles.push(workerHandle)
      const prompts = { lead: 'Lead fixture', worker: 'Sidekick fixture', compact: 'Compact fixture' }
      const binding: SessionBinding = { schemaVersion: 1, sessionId: leadHandle.agent.id, selected: true,
        taskId: TaskId('windows-readonly'), prompts, profile: completeProfile({
          id: 'fusion-auto', version: 'faithful-v1', enabled: true, interactionMode: 'model-like', workflowPolicy: 'enforced-v3',
          lead: { provider: 'test-readonly', model: 'lead' }, worker: { provider: 'test-readonly', model: 'worker' },
        }, prompts) }
      const roles = new NativeRoleSandbox(ctx, store, id => id === binding.sessionId ? binding : undefined)
      roles.ensure(leadHandle.agent, binding, 'lead')
      workerHandle.agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })
      roles.ensure(workerHandle.agent, binding, 'worker')
      expect(ctx.sandboxPolicy.resolve({ session: leadHandle.agent.session }).mode).toBe('read-only')
      expect(ctx.sandboxPolicy.resolve({ session: workerHandle.agent.session }).mode).toBe('workspace-write')
      const call = (handle: typeof leadHandle, id: string) => ctx.tools.execute({
        name: 'pwsh', callId: ToolCallId(id), agent: handle.agent, signal: new AbortController().signal,
        arguments: { command: 'Set-Content probe.txt test', description: 'Write the test-owned probe file', workdir: workspace },
      })
      const denied = await call(leadHandle, 'lead-write')
      expect(denied.isError, JSON.stringify(denied)).not.toBe(true)
      expect(denied.value).toMatchObject({ kind: 'foreground', timedOut: false, aborted: false,
        sandbox: { mode: 'read-only', denied: true, enforcement: 'partial' } })
      expect((denied.value as { exitCode: number | null }).exitCode).not.toBe(0)
      expect(existsSync(join(workspace, 'probe.txt'))).toBe(false)
      const allowed = await call(workerHandle, 'worker-write')
      expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true)
      expect(allowed.value).toMatchObject({ kind: 'foreground', exitCode: 0, timedOut: false, aborted: false,
        sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' } })
      expect(readFileSync(join(workspace, 'probe.txt'), 'utf8').trim()).toBe('test')
      expect(adapter.requests).toHaveLength(0)
      roles.restore(leadHandle.agent)
      expect(ctx.sandboxPolicy.resolve({ session: leadHandle.agent.session }).mode).toBe('workspace-write')
    } finally {
      for (const handle of handles.reverse()) await handle.dispose()
      await ctx.fiber.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 90_000)
})
