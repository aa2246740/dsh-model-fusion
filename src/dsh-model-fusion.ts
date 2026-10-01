import { bi } from './bilingual.js'
import { backfillHistory, readHistory } from './host/history.js'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { FusionCatalogAdapter, FUSION_PROVIDER, FUSION_MODEL, installNativeFusionSelection } from './host/native-selection.js'
import type { ResolvedProfile } from './profile/resolve.js'
import { choiceFromProfile, modelProfileFromChoice, validatePairChoice, savedLeadRoute } from './host/settings.js'
import { CachePolicy, cacheView } from './host/cache-policy.js'
import { CACHE_DEFAULTS_CHECKED } from './host/cache-defaults.js'
import { loadJsonObject, resolveProfile } from './profile/resolve.js'
import { profileRoutes } from './profile/compactor.js'
import { loadModelPromptBundle, loadPromptBundle } from './prompts.js'
import { SqliteFusionStore } from './task/sqlite-store.js'
import { BindingRepository, type SessionBinding } from './host/bindings.js'
import { FusionCoordinator } from './host/coordinator.js'
import { authorizeConfiguredPair, NativeRequestBudget } from './host/native-budget.js'
import { json, readJson, trustedRequest } from './host/http.js'
import { readFusionStatus } from './host/status.js'
import { readHistoricalFusionActivity } from './host/native-activity.js'
import { nativeShellTool } from './host/shell.js'

export * from './index.js'

export const name = 'dsh-model-fusion'
export const inject = ['agents', 'sessions', 'llm', 'tools', 'subagents', 'systemPrompt', 'webServer', 'sessionController', 'sessionQuery', 'commands', 'agentDefaultModel', 'tokenMeter']
export interface Config { profilePath?: string; authorizationPath?: string; databasePath?: string; workerTools?: string[] }
const defaultWorkerTools = [nativeShellTool, 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_kill']
// Schemastery otherwise normalizes an omitted array to [], bypassing ?? below.
// An explicitly empty list must remain empty, so the default belongs in the schema.
export const Config: z<Config> = z.object({ profilePath: z.string(), authorizationPath: z.string(), databasePath: z.string(),
  workerTools: z.array(z.string()).default(defaultWorkerTools) })

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const database = config.databasePath || join(dshHome, 'plugins', name, 'state.sqlite')
  if (!isAbsolute(database)) throw new Error('Fusion databasePath must be absolute')
  const store = new SqliteFusionStore(database), bindings = new BindingRepository(store)
  const cachePolicy = new CachePolicy(store)
  backfillHistory(store)
  const budget = new NativeRequestBudget(store, config.authorizationPath)
  let defaultProfile: ResolvedProfile | undefined
  const physicalCatalog = async () => {
    const catalog = await ctx.sessionController.modelCatalog()
    return { ...catalog, groups: catalog.groups.filter(group => group.id !== FUSION_PROVIDER) }
  }
  const configuredProfile = async (): Promise<ResolvedProfile> => {
    defaultProfile = undefined
    const saved = store.readDocument('settings:profile')
    if (!saved && (!config.profilePath || !isAbsolute(config.profilePath))) throw new Error(bi('请先在设置的 Fusion 页面选择 Lead 和 Worker', 'Open Settings → Fusion and choose a Lead and a Sidekick first'))
    const raw = saved?.value as Record<string, unknown> | undefined ?? loadJsonObject(config.profilePath!)
    const catalog = await physicalCatalog()
    const pair = validatePairChoice(raw, catalog)
    const next = saved ? modelProfileFromChoice(pair) : raw
    defaultProfile = resolveProfile(next, next.interactionMode === 'model-like' ? loadModelPromptBundle() : loadPromptBundle(), { authorizedRoutes: catalog.groups.flatMap(group =>
      group.models.map(model => ({ provider: group.id, model: model.id }))) })
    return defaultProfile
  }
  const needsBudget = (profile: ResolvedProfile['profile']) => Boolean(config.authorizationPath) || profile.interactionMode !== 'model-like'
  let runtime: FusionCoordinator | undefined
  const effectiveRoutes = (binding: SessionBinding) => profileRoutes({ ...binding.profile,
    lead: runtime?.modelControl.route(binding, 'lead') ?? binding.profile.lead,
    worker: runtime?.modelControl.route(binding, 'worker') ?? binding.profile.worker })
  let creating: Promise<FusionCoordinator> | undefined
  const getRuntime = (frozen?: ResolvedProfile): Promise<FusionCoordinator> => {
    if (runtime) return Promise.resolve(runtime)
    if (creating) return creating
    creating = (async () => {
      const profile = frozen ?? await configuredProfile()
      runtime = new FusionCoordinator(ctx, store, { profile, workerTools: config.workerTools ?? defaultWorkerTools,
        resumeAuthorization: binding => needsBudget(binding.profile) ? budget.check(effectiveRoutes(binding)).authorizationId : 'native-account',
        authorizeRequest: (_agent, binding) => {
          if (!needsBudget(binding.profile)) return
          try { budget.check(effectiveRoutes(binding)) }
          catch (error) {
            const state = store.load(binding.taskId)
            if (state?.control.mode === 'running' && !state.control.budgetBlocked) runtime?.append(binding.taskId, 'budget/blocked', { reason: String(error) })
            throw error
          }
        },
        reserveRequest: (request, binding) => {
          if (!needsBudget(binding.profile)) return
          try { budget.reserve({ provider: request.provider, model: request.model }, request.maxTokens ?? 0) }
          catch (error) {
            const state = store.load(binding.taskId)
            if (state?.control.mode === 'running' && !state.control.budgetBlocked) runtime?.append(binding.taskId, 'budget/blocked', { reason: String(error) })
            throw error
          }
        } })
      return runtime
    })().finally(() => { creating = undefined })
    return creating
  }
  // The catalog entry admits what the configured Lead admits: the Lead is the
  // only role that reads user content, while the Worker receives text work orders.
  const leadInputModalities = async (): Promise<readonly ModelModality[] | undefined> => {
    try {
      const saved = store.readDocument('settings:profile')?.value
      const lead = savedLeadRoute(saved)
        ?? (config.profilePath && isAbsolute(config.profilePath) ? savedLeadRoute(loadJsonObject(config.profilePath)) : undefined)
      if (!lead) return undefined
      return (await ctx.llm.resolveModelInfo(lead.provider, lead.model)).inputModalities
    } catch {
      // An unresolvable Lead route (unregistered provider, retired model, broken
      // profile file) cannot verify image support; the catalog entry stays text-only.
      return undefined
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([FUSION_PROVIDER], new FusionCatalogAdapter(leadInputModalities)))
  ctx.effect(() => installNativeFusionSelection(ctx, {
    coordinator: () => runtime, profile: () => defaultProfile,
    selection: agent => {
      const selection = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
      if (selection?.type === 'model/selection') return selection.data
      if (bindings.read(agent.id)?.binding.selected) return { provider: FUSION_PROVIDER, model: FUSION_MODEL }
      const header = agent.session.requestHeader()
      return header ? { provider: header.config.provider, model: header.config.model } : ctx.agentDefaultModel.currentSelection()
    },
  }))
  // Frozen bindings must be restored before another user request is allowed.
  const restoreFailure = new Map<string, string>()
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const binding = bindings.read(payload.agent.id)?.binding
    if (!binding?.selected) return next()
    try { await getRuntime({ profile: binding.profile, prompts: binding.prompts }); if (restoreFailure.has(payload.agent.id)) restoreFailure.delete(payload.agent.id) }
    catch (error) { restoreFailure.set(payload.agent.id, String(error)); return { kind: 'reject' } }
    return next()
  }, { prepend: true }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/model-fusion', handler: async (req, res) => {
    if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET') {
        if (url.searchParams.get('view') === 'history') return json(res, 200, readHistory(store, url.searchParams.get('cursor') ?? ''))
        if (url.searchParams.get('view') === 'activity') return json(res, 200, await readHistoricalFusionActivity(ctx, store,
          url.searchParams.get('sessionId') ?? '', url.searchParams.get('callId') ?? '', Number(url.searchParams.get('after') ?? -1)))
        if (url.searchParams.get('view') === 'status') return json(res, 200, readFusionStatus(store, url.searchParams.get('sessionId') ?? ''))
        if (url.searchParams.get('view') === 'catalog') return json(res, 200, await ctx.sessionController.modelCatalog())
        if (url.searchParams.get('view') === 'cache') {
          let profile: ResolvedProfile | undefined
          try { profile = await configuredProfile() } catch { profile = undefined }
          return json(res, 200, { checked: CACHE_DEFAULTS_CHECKED, models: cacheView(cachePolicy,
            profile ? { lead: profile.profile.lead, worker: profile.profile.worker } : undefined, profile?.profile.cacheKeepalive) })
        }
        if (url.searchParams.get('view') === 'settings') {
          const saved = store.readDocument('settings:profile')
          let profile: ResolvedProfile | undefined, reason: string | undefined, authorized = false
          try {
            profile = await configuredProfile()
            if (needsBudget(profile.profile)) budget.check(profileRoutes(profile.profile)); authorized = true
          } catch (error) { reason = error instanceof Error ? error.message : String(error) }
          return json(res, 200, { revision: saved?.revision ?? 0, catalog: await physicalCatalog(),
            pair: profile ? choiceFromProfile(profile.profile) : null,
            authorized, reason, managedAuthorization: Boolean(config.authorizationPath), policy: profile?.profile.interactionMode ?? 'legacy', actualBilledUsd: null, apiEquivalentUsd: null })
        }
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const binding = sessionId && bindings.read(sessionId)?.binding
        let available = false, reason: string | undefined
        try {
          const profile = binding && binding.selected ? { profile: binding.profile, prompts: binding.prompts } : await configuredProfile()
          const controller = await getRuntime(profile)
          controller.transport.assertAvailable()
          if (needsBudget(profile.profile)) budget.check(profileRoutes(profile.profile))
          available = true
        } catch (error) { reason = error instanceof Error ? error.message : String(error) }
        const state = binding && store.load(binding.taskId)
        return json(res, 200, { selected: Boolean(binding && binding.selected), available, ...(reason ? { reason } : {}),
          ...(state ? { task: { id: state.taskId, phase: state.phase, verification: state.verification, workerId: state.acceptedChild } } : {}) })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      const body = await readJson(req)
      if (['continue', 'switch-role', 'schedule', 'cancel-schedule'].includes(String(body.action))) {
        if (typeof body.sessionId !== 'string' || typeof body.taskId !== 'string' || !Number.isSafeInteger(body.revision)) throw new Error(bi('恢复参数无效', 'Invalid recovery parameters'))
        const saved = bindings.read(body.sessionId)
        if (!saved?.binding.selected || saved.binding.taskId !== body.taskId || saved.binding.profile.interactionMode !== 'model-like') throw new Error(bi('当前任务不支持此恢复操作', 'This task does not support that recovery action'))
        const binding = saved.binding
        const controller = await getRuntime({ profile: binding.profile, prompts: binding.prompts })
        if (needsBudget(binding.profile)) budget.check(effectiveRoutes(binding))
        if (body.action === 'cancel-schedule') {
          const row = store.readDocument(`model-control:${body.sessionId}`)
          if (row?.revision !== body.revision) throw new Error(bi('状态已变化，请刷新', 'The state changed; refresh'))
          controller.modelControl.cancel(binding)
        } else if (body.action === 'schedule') {
          if (typeof body.dueAt !== 'string') throw new Error(bi('请选择继续时间', 'Choose when to continue'))
          await controller.modelControl.schedule(body.sessionId, body.taskId, Number(body.revision), body.dueAt)
        } else {
          let change: { role: 'lead' | 'worker'; route: typeof binding.profile.lead } | undefined
          if (body.action === 'switch-role') {
            if (body.role !== 'lead' && body.role !== 'worker') throw new Error(bi('请选择要更换的角色', 'Choose the role to switch'))
            const pair = validatePairChoice({ lead: body.route, worker: body.route }, await physicalCatalog())
            change = { role: body.role, route: pair.lead }
            if (needsBudget(binding.profile)) budget.check(profileRoutes({ ...binding.profile,
              lead: controller.modelControl.route(binding, 'lead'), worker: controller.modelControl.route(binding, 'worker'), [change.role]: change.route }))
          }
          await controller.modelControl.continue(body.sessionId, body.taskId, Number(body.revision), change)
        }
        return json(res, 200, { ok: true })
      }
      if (body.action === 'cache-setting') {
        if (typeof body.provider !== 'string' || typeof body.model !== 'string' || !body.provider || !body.model) throw new Error(bi('请选择模型', 'Choose a model'))
        const setting = body.reset === true ? null : {
          ...(body.mode === undefined || body.mode === null ? {} : { mode: body.mode as 'auto' | 'on' | 'off' }),
          ...(body.intervalSeconds === undefined || body.intervalSeconds === null ? {} : { intervalSeconds: Number(body.intervalSeconds) }) }
        cachePolicy.save(body.provider, body.model, setting)
        return json(res, 200, { ok: true })
      }
      if (body.action === 'configure') {
        if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error(bi('配置版本无效，请刷新后重试', 'Invalid settings revision; refresh and retry'))
        const pair = validatePairChoice(body.pair, await physicalCatalog())
        const revision = store.writeDocument('settings:profile', Number(body.revision), modelProfileFromChoice(pair))
        const profile = await configuredProfile()
        await getRuntime(profile)
        return json(res, 200, { ok: true, revision })
      }
      if (body.action === 'authorize') {
        if (config.authorizationPath) throw new Error(bi('运行额度由外部授权文件管理，不能在此覆盖', 'Run limits are managed by an external authorization file and cannot be overridden here'))
        const saved = store.readDocument('settings:profile')
        if (!saved || saved.revision !== body.revision) throw new Error(bi('模型组合已变化，请刷新后再启用额度', 'The pair changed; refresh before enabling limits'))
        const profile = await configuredProfile()
        if (store.readDocument('settings:profile')?.revision !== body.revision) throw new Error(bi('模型组合已变化，请刷新后再启用额度', 'The pair changed; refresh before enabling limits'))
        const auth = authorizeConfiguredPair(store, profileRoutes(profile.profile), body.limits)
        return json(res, 200, { ok: true, expiresAt: auth.expiresAt })
      }
      throw new Error(bi('请使用原模型菜单选择 Fusion 或切换普通模型', 'Use the model menu to select Fusion or another model'))
    } catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
  } }))
  ctx.effect(() => ctx.commands.register({ name: 'fusion', description: bi('Fusion 状态、暂停、恢复与退出（不调用模型）', 'Fusion status, pause, resume and exit (no model call)'),
    input: { hint: bi('status | pause | resume | recover [--effects-stopped] <检查记录> | off', 'status | pause | resume | recover [--effects-stopped] <inspection note> | off') },
    handler: async invocation => {
      const [action = 'status', ...note] = invocation.rawInput.trim().split(/\s+/)
      try {
        const binding = bindings.read(invocation.agent.id)?.binding
        if (!binding?.selected) return { kind: 'success', text: bi('当前会话未启用 Fusion。请在模型选择器中选择 Fusion · 自动。', 'Fusion is not selected in this conversation. Choose Fusion · auto in the model menu.') }
        if (action === 'status' || action === '') {
          const controller = await getRuntime({ profile: binding.profile, prompts: binding.prompts })
          const state = store.load(binding.taskId)!
          const unfinishedEffects = controller.effects.pending(binding.taskId).map(({ record }) => ({ role: record.role, tool: record.toolName }))
          const usage = store.listDocumentIds(`usage:${state.taskId}:`).map(id => store.readDocument(id)!.value as { purpose?: string })
          return { kind: 'success', text: JSON.stringify({ taskId: state.taskId, phase: state.phase, verification: state.verification,
            control: state.control, workerId: state.acceptedChild, modelCalls: usage.length,
            cacheKeepaliveCalls: usage.filter(row => row.purpose === 'cache-keepalive').length,
            compactionCalls: usage.filter(row => row.purpose === 'compaction').length,
            unfinishedEffects, ...(unfinishedEffects.length ? { recoveryHint: bi('请核对中断的工具操作，确认对应命令及子进程已停止；Host 退出不代表这些操作已结束。', 'Check the interrupted tool operations and confirm their commands and child processes stopped; a Host exit does not end them.') } : {}),
            actualBilledUsd: null, apiEquivalentUsd: null }, null, 2) }
        }
        const controller = await getRuntime({ profile: binding.profile, prompts: binding.prompts })
        if (action === 'pause') { controller.modelControl.cancel(binding); await controller.pause(invocation.agent) }
        else if (action === 'resume') {
          const authorizationId = needsBudget(binding.profile) ? budget.check(effectiveRoutes(binding)).authorizationId : 'native-account'
          if (binding.profile.interactionMode === 'model-like') await controller.modelControl.continue(binding.sessionId, binding.taskId,
            store.readDocument(`model-control:${binding.sessionId}`)?.revision ?? 0)
          else await controller.resume(invocation.agent, authorizationId)
        } else if (action === 'recover') await controller.reconcile(invocation.agent, { commandId: invocation.commandId,
          effectsStopped: note[0] === '--effects-stopped', note: (note[0] === '--effects-stopped' ? note.slice(1) : note).join(' ') })
        else if (action === 'off') {
          await controller.clear(invocation.agent)
          await ctx.sessionController.selectModel({ sessionId: SessionId(invocation.agent.id), ...binding.profile.lead })
        }
        else throw new Error(bi('使用 /fusion status、pause、resume、recover <检查记录> 或 off', 'Use /fusion status, pause, resume, recover <inspection note> or off'))
        return { kind: 'success', text: action === 'resume' ? binding.profile.interactionMode === 'model-like' ? bi('已通过原生收件箱提交一次继续操作。', 'One continuation was submitted through the native inbox.') : bi('Fusion 已恢复。发送下一条消息继续当前任务。', 'Fusion resumed. Send a message to continue the task.') : bi(`Fusion ${action} 已完成。`, `Fusion ${action} done.`) }
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) } }
    } }))
  ctx.effect(() => async () => { if (creating) await creating.catch(() => undefined); if (runtime) await runtime.close(); store.close() })
  // Warm only configuration/scopes; initialization performs no inference.
  try { await getRuntime(await configuredProfile()) }
  catch {
    const selected = bindings.selected()[0]
    if (selected) await getRuntime({ profile: selected.profile, prompts: selected.prompts })
  }
  ctx.logger.info('[my-plugins/dsh-model-fusion] loaded')
}
