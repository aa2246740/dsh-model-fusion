import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { TaskId } from '../contracts.js'
import type { PhysicalRoute } from '../contracts.js'
import { digestOf } from '../digest.js'
import { FusionCoordinator } from '../host/coordinator.js'
import { NativeRequestBudget } from '../host/native-budget.js'
import { nativeRequestAgent } from '../host/native-request.js'
import { observeNativeUsage } from '../host/native-usage.js'
import type { NativeUsageRecord } from '../host/native-usage.js'
import { nativeShellTool } from '../host/shell.js'
import { snapshotWorkspace } from '../host/workspace.js'
import type { ResolvedProfile } from '../profile/resolve.js'
import { profileRoutes } from '../profile/compactor.js'
import { SqliteFusionStore } from '../task/sqlite-store.js'
import { NaiveCoordinator, naivePrompts } from './naive.js'
import { resolveBenchmarkOutputLimits, type BenchmarkOutputLimits } from './output-limits.js'

export interface NativeBenchmarkOptions {
  runId: string
  variant: 'lead_only' | 'worker_only' | 'worker_selfreview' | 'naive' | 'fusion'
  dataKind: 'real' | 'synthetic'
  /** Version read by the trusted launcher from the loaded artifact's metadata. */
  engineVersion?: string
  workspace: string
  /** Fresh directory, outside the candidate's filesystem. Never reused. */
  output: string
  prompt: string
  profile: ResolvedProfile
  /** Required for real runs: exact public model limits frozen before the attempt. */
  outputLimits?: BenchmarkOutputLimits
  /** One campaign-wide ledger, so attempts cannot reset the approved limit. */
  budget: NativeRequestBudget
  maxRequests: number
  timeoutMs: number
}

// This is an explicit benchmark treatment, not a change to the Fusion prompt.
// The same Worker, tools, deadline and allowance cover both native turns.
const selfReviewPrompt = `Perform a second self-review of your work against the original user request. Inspect the current implementation, look for defects or missed requirements, fix any you find, and run the relevant tests. Preserve the existing acceptance tests. Use the remaining allowance for this same attempt; no additional budget has been granted. Finish with the result of this review and any unresolved limitations.`

/**
 * Run one fresh attempt through the same native AgentLoop and FusionCoordinator
 * as the product. The caller composes public Host services and a sandboxed shell;
 * this function does not implement another LLM/tool loop or grade candidate code.
 */
export async function runNativeBenchmark(ctx: Context, options: NativeBenchmarkOptions) {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(options.runId)) throw new Error('Invalid run id')
  if (!['lead_only', 'worker_only', 'worker_selfreview', 'naive', 'fusion'].includes(options.variant)
    || !['real', 'synthetic'].includes(options.dataKind)) throw new Error('Invalid benchmark mode')
  if (!options.prompt.trim() || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Bounded attempt limits required')
  if (options.dataKind === 'real' && !options.outputLimits) throw new Error('Real attempts require preregistered role output limits')
  const { profile, prompts } = options.profile
  const benchmarkTools = [nativeShellTool, 'read', 'glob', 'grep']
  for (const name of benchmarkTools) {
    if (!ctx.tools.get(name)) throw new Error(`Native benchmark requires the ${name} tool before any model request`)
  }
  if (!profile.enabled) throw new Error('Disabled benchmark profile')
  const workspace = realpathSync(options.workspace)
  const inWorkspace = (path: string) => {
    const rel = relative(workspace, resolve(path))
    return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  }
  if (inWorkspace(options.output) || inWorkspace(options.budget.store.filename)
    || options.budget.authorizationFile && inWorkspace(options.budget.authorizationFile)) {
    throw new Error('Benchmark controller state and authorization must be outside the candidate workspace')
  }
  const selfReview = options.variant === 'worker_selfreview'
  const role = options.variant === 'worker_only' || selfReview ? 'worker' : 'lead'
  const route = profile[role]
  const nativeRoute = { provider: route.provider, model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}) }
  options.budget.check(options.variant === 'fusion' ? profileRoutes(profile)
    : options.variant === 'naive' ? [profile.lead, profile.worker] : [route])
  const outputLimits = await resolveBenchmarkOutputLimits(ctx, profile)
  if (options.outputLimits && digestOf(options.outputLimits) !== digestOf(outputLimits)) {
    throw new Error('Frozen role output limits changed; preregister the new conditions before model calls')
  }
  // mkdir without recursive prevents overwriting any earlier attempt evidence.
  mkdirSync(options.output, { mode: 0o700 })
  const before = snapshotWorkspace(workspace)
  const store = new SqliteFusionStore(join(options.output, 'fusion.sqlite'))
  const soloTask = TaskId(`benchmark-${options.runId}`)
  const startedAt = new Date().toISOString(), started = performance.now()
  let requests = 0, timedOut = false, failure: string | null = null
  let coordinator: FusionCoordinator | undefined
  let naive: NaiveCoordinator | undefined
  let stopUsage: (() => void) | undefined
  let stopGuard: (() => void) | undefined
  let stopSessions: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let workerSession: Session | undefined
  const childSessions = new Map<string, Session>()
  const phases: Array<{ stage: 'implementation' | 'self_review'; completed: boolean; nativeRequests: number; endReason: unknown }> = []
  const reserve = (actual: PhysicalRoute, maxTokens: number) => {
    if (requests >= options.maxRequests) throw new Error('Attempt native request limit exhausted')
    options.budget.reserve(actual, maxTokens)
    requests++
  }
  let parent
  try {
    parent = (await ctx.agents.create({ sessionId: SessionId(`bench-${options.runId}-${randomUUID()}`),
      meta: { cwd: workspace }, agentOptions: { ...nativeRoute, maxTokens: outputLimits.roles[role].maxTokens } })).agent
    installModelSelection(parent.ctx, { current: nativeRoute, assembled: undefined })
  } catch (error) { store.close(); throw error }
  let taskId = soloTask
  try {
    // The native parent turn can drain its child before whenIdle returns. Keep
    // public Session references from creation, including restored generations.
    stopSessions = ctx.on('session/created', session => {
      if (session.header.parentSession === parent.id) childSessions.set(session.id, session)
    })
    if (options.variant === 'fusion') {
      coordinator = new FusionCoordinator(ctx, store, { profile: options.profile, workerTools: benchmarkTools,
        leaseRoot: join(options.output, 'leases'), maxWorkerSteps: options.maxRequests, commandMaxSeconds: 60,
        authorizeRequest: (_agent, binding) => { options.budget.check(profileRoutes(binding.profile)) },
        reserveRequest: request => reserve(request, request.maxTokens ?? 0) })
      await coordinator.select(parent)
      taskId = coordinator.bindings.read(parent.id)!.binding.taskId
    } else {
      if (options.variant === 'naive') naive = new NaiveCoordinator(ctx, parent, store, profile, outputLimits.roles.worker.maxTokens, benchmarkTools)
      stopUsage = observeNativeUsage(ctx, store, agent => agent === parent ? { taskId, role }
        : naive?.owns(agent) ? { taskId, role: 'worker' } : undefined)
    }
    stopGuard = ctx.on('llm/stream', async function* (request, next) {
      const agent = nativeRequestAgent(ctx, request)
      if (!agent || (coordinator ? !coordinator.owner(agent) : naive ? !naive.owns(agent) : agent !== parent)) {
        throw new Error('Benchmark refuses unowned auxiliary model calls')
      }
      naive?.assertReady()
      if (isAgentLoopRequest(request) && request.purpose === undefined) {
        const requestRole = coordinator?.owner(agent)?.role ?? (agent === parent ? role : 'worker')
        const frozen = outputLimits.roles[requestRole]
        if (request.provider !== frozen.provider || request.model !== frozen.model || request.maxTokens !== frozen.maxTokens) {
          throw new Error(`Benchmark ${requestRole} request diverged from frozen role output limits`)
        }
      }
      if (!coordinator) reserve(request, request.maxTokens ?? 0)
      yield* next()
    }, { prepend: true })
    const frozen = { schemaVersion: 1, runId: options.runId, variant: options.variant, dataKind: options.dataKind,
      startedAt, pluginVersion: options.engineVersion ?? 'unknown', profile, promptsDigest: digestOf(prompts), taskPromptDigest: digestOf(options.prompt),
      initialSnapshot: before, maxRequests: options.maxRequests, timeoutMs: options.timeoutMs, outputLimits,
      protocol: { requiredStages: selfReview ? ['implementation', 'self_review'] : ['implementation'],
        selfReviewPromptDigest: selfReview ? digestOf(selfReviewPrompt) : null,
        ...(naive ? { delegationMode: 'fresh-one-shot', rolePromptsDigest: digestOf(naivePrompts),
          completionRule: 'parent-completed-and-children-quiescent' } : {}) },
      tools: benchmarkTools, readToolSemantics: 'readonly-command-vm-python-regex-fnmatch-v1',
      commandNetwork: 'caller-must-attest', authorizationId: options.budget.check([route]).authorizationId }
    writeFileSync(join(options.output, 'manifest.json'), JSON.stringify(frozen, null, 2), { mode: 0o600, flag: 'wx' })
    timer = setTimeout(() => {
      timedOut = true
      parent.cancel({ kind: 'hook', reason: 'Benchmark attempt deadline' })
      for (const childId of childSessions.keys()) ctx.agents.get(SessionId(childId))?.cancel({ kind: 'hook', reason: 'Benchmark attempt deadline' })
    }, options.timeoutMs)
    const turn = async (stage: 'implementation' | 'self_review', text: string) => {
      const start = parent.session.snapshotEvents().length
      const requestsBefore = requests
      parent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await parent.whenIdle()
      const end = parent.session.snapshotEvents().slice(start).findLast(event => event.type === 'turn/end')
      const endReason = end?.type === 'turn/end' ? end.data.reason : null
      phases.push({ stage, completed: endReason?.kind === 'completed', nativeRequests: requests - requestsBefore, endReason })
    }
    await turn('implementation', options.prompt)
    if (selfReview && phases[0]?.completed && !timedOut) await turn('self_review', selfReviewPrompt)
  } catch (error) { failure = String(error) }
  finally {
    if (timer) clearTimeout(timer)
    // Native release removes the Agent handle. Read the retained public
    // Session only after close proves quiescence, including final events.
    const childId = coordinator?.bindings.read(parent.id)?.binding.workerId
    workerSession = childId ? childSessions.get(childId) : undefined
    // Await the persistent child and native tools before declaring a snapshot.
    try { await coordinator?.close(); await naive?.close() }
    catch (error) { store.close(); throw error }
    finally { stopGuard?.(); stopUsage?.(); stopSessions?.() }
  }
  try {
    const state = coordinator?.state(taskId)
    const events = parent.session.snapshotEvents()
    const end = events.findLast(event => event.type === 'turn/end')
    const endReason = end?.type === 'turn/end' ? end.data.reason : null
    const protocolComplete = !timedOut && !failure && endReason?.kind === 'completed'
      && phases.length === (selfReview ? 2 : 1) && phases.every(phase => phase.completed)
      && (state ? state.phase === 'COMPLETED' && state.verification === 'verified' && !state.outcomeUnknown : true)
    const usage = store.listDocumentIds(`usage:${taskId}:`).map(id => store.readDocument(id)!.value as NativeUsageRecord)
    const delivered = snapshotWorkspace(workspace)
    const workers = naive ? [...childSessions.values()] : workerSession ? [workerSession] : []
    const workerSessions = workers.map((session, index) => ({ sessionId: session.id,
      parentSessionId: session.header.parentSession, eventsFile: naive ? `worker-events-${String(index + 1).padStart(3, '0')}.json` : 'worker-events.json' }))
    const result = { schemaVersion: 1, runId: options.runId, variant: options.variant, dataKind: options.dataKind,
      startedAt, endedAt: new Date().toISOString(), wallSeconds: (performance.now() - started) / 1000,
      parentSessionId: parent.id, workerSessionId: coordinator?.bindings.read(parent.id)?.binding.workerId ?? null,
      taskId, nativeRequests: requests, protocolComplete, artifactPass: null,
      workerParentSessionId: workerSession?.header.parentSession ?? null,
      workerSessions, ...(naive ? { naiveDelegations: naive.delegations } : {}),
      status: timedOut ? 'timeout' : protocolComplete ? 'completed' : 'failed', failure, endReason, phases,
      deliveredSnapshot: delivered, fusionState: state ?? null, usage,
      actualBilledUsd: null, apiEquivalentUsd: null, upstreamHttpCalls: null }
    writeFileSync(join(options.output, 'parent-events.json'), JSON.stringify(events, null, 2), { mode: 0o600, flag: 'wx' })
    workers.forEach((session, index) => writeFileSync(join(options.output, workerSessions[index]!.eventsFile),
      JSON.stringify(session.snapshotEvents(), null, 2), { mode: 0o600, flag: 'wx' }))
    writeFileSync(join(options.output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
    return result
  } finally { store.close() }
}

export { NativeRequestBudget }
