import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { PhysicalRoute } from '../contracts.js'
import type { ResolvedProfile } from '../profile/resolve.js'
import type { FusionCoordinator } from './coordinator.js'

export const FUSION_PROVIDER = 'dsh-model-fusion'
export const FUSION_MODEL = 'auto'
export const isFusionSelection = (route: { provider?: string; model?: string } | undefined): boolean =>
  route?.provider === FUSION_PROVIDER && route.model === FUSION_MODEL

/** Resolves the configured Lead's declared input modalities; undefined means unconfigured or unverifiable. */
export type LeadInputModalities = () => Promise<readonly ModelModality[] | undefined>

/** Catalog-only local adapter; the native request is physically routed before dispatch. */
export class FusionCatalogAdapter extends LlmAdapter {
  constructor(private readonly leadInputModalities?: LeadInputModalities) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'Fusion' } }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // The Lead is the only role that reads user content, so the entry admits
    // exactly what the configured Lead admits; text-only until it resolves.
    const lead = (await this.leadInputModalities?.()) ?? []
    return [{ provider, id: FUSION_MODEL, name: 'Fusion · 自动',
      description: 'Lead 与 Worker 协作。在设置 → Fusion 中配置模型。',
      inputModalities: [...new Set<ModelModality>(['text', ...lead])] }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== FUSION_PROVIDER || model !== FUSION_MODEL) throw new Error('Unknown local Fusion selection')
    return (await this.listModels(provider))[0]!
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Fusion 尚未就绪。请前往设置 → Fusion 配置 Lead 和 Worker。')
  }
}

/** Public native lifecycle integration. No model-menu replacement or Host patch. */
export function installNativeFusionSelection(ctx: Context, input: {
  coordinator(): FusionCoordinator | undefined
  profile(): ResolvedProfile | undefined
  selection(agent: Agent): PhysicalRoute | undefined
}): () => void {
  const pending = new Map<string, Promise<void>>()
  const failures = new Map<string, string>()
  const desired = new Map<string, PhysicalRoute>()
  const selection = (agent: Agent) => desired.get(agent.id) ?? input.selection(agent)
  const selected = (agent: Agent) => input.coordinator()?.bindings.read(agent.id)?.binding.selected === true
  const change = (agent: Agent) => {
    if (agent.session.header.parentSession || pending.has(agent.id)) return
    const coordinator = input.coordinator(), profile = input.profile(), route = selection(agent)
    if (!coordinator) return
    if (isFusionSelection(route)) {
      if (!selected(agent) && profile) coordinator.selectBeforeAssembly(agent, profile)
      if (selected(agent)) {
        // A saved Host default need not emit model/selection. Persist that
        // already-chosen intent before physical headers reach the native menu's
        // projection, otherwise it starts displaying the Lead as the selection.
        const intent = agent.session.snapshotEvents().findLast(event => event.type === 'model/selection')
        if (!isFusionSelection(intent?.data)) agent.session.append('model/selection', {
          provider: FUSION_PROVIDER, model: FUSION_MODEL,
        })
        failures.delete(agent.id)
      }
      return
    }
    if (!selected(agent)) return
    const transition = (async () => {
      if (agent.status !== 'idle') await coordinator.pause(agent)
      await coordinator.clear(agent)
      failures.delete(agent.id)
    })().catch(error => { failures.set(agent.id, String(error)) }).finally(() => { pending.delete(agent.id) })
    pending.set(agent.id, transition)
  }
  const disposers = [
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection') return
      desired.set(session.id, event.data)
      const agent = ctx.agents.get(SessionId(session.id))
      if (agent && (agent.status === 'idle' || !isFusionSelection(event.data))) change(agent)
      else if (agent && !selected(agent)) agent.cancel({ kind: 'hook', reason: 'Fusion selection takes effect after this turn settles' }, { keepInbox: true })
    }),
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running' || agent.session.header.parentSession) return
      if (pending.has(agent.id) && selected(agent)) {
        agent.cancel({ kind: 'hook', reason: 'Model switch is draining the previous Fusion task' }, { keepInbox: true })
        return
      }
      // The synchronous running reservation precedes prompt/tool assembly.
      try { change(agent) } catch (error) { failures.set(agent.id, String(error)) }
    }),
    ctx.on('agent/request', async (payload, next) => {
      const config = await next(), agent = payload.agent
      if (agent.session.header.parentSession) return config
      const route = selection(agent)
      if ((pending.has(agent.id) && selected(agent)) || failures.has(agent.id)) throw new Error(failures.get(agent.id) ?? 'Fusion 正在完成模型切换，请稍后继续')
      if (isFusionSelection(route)) {
        // A newly installed exact-Agent interceptor can wrap this listener;
        // its physical route is applied after this continuation returns.
        // The catalog adapter itself cannot dispatch any upstream request.
        if (!selected(agent)) throw new Error('请先在设置 → Fusion 配置 Lead 和 Worker，再继续此会话。')
      } else if (selected(agent)) throw new Error('先停止当前 Fusion 任务，再切换模型。')
      return config
    }, { prepend: true }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
