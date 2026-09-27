import { bi } from '../bilingual.js'
import type { PairProfile, PhysicalRoute } from '../contracts.js'
import { keepaliveChoice } from '../profile/keepalive.js'
import { compactorChoice } from '../profile/compactor.js'
import { FUSION_PROVIDER } from './native-selection.js'

export interface PairChoice {
  lead: PhysicalRoute
  worker: PhysicalRoute
  outputTokens?: Partial<Record<'lead' | 'worker', number>>
  cacheKeepalive?: PairProfile['cacheKeepalive']
  compactor?: PairProfile['compactor']
}
export interface SettingsCatalog {
  groups: readonly { id: string; name: string; models: readonly {
    id: string; name: string; reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
  }[] }[]
}

/** Configuration chooses registered physical models; it cannot create adapters. */
export function validatePairChoice(value: unknown, catalog: SettingsCatalog): PairChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(bi('请选择 Lead 和 Worker', 'Choose a Lead and a Sidekick'))
  const raw = value as Record<string, unknown>
  const route = (role: string, candidate: unknown): PhysicalRoute => {
    const item = candidate as Record<string, unknown> | undefined
    if (!item || typeof item.provider !== 'string' || typeof item.model !== 'string') throw new Error(bi(`请选择 ${role} 模型`, `Choose the ${role} model`))
    if (item.provider === FUSION_PROVIDER) throw new Error(bi('Fusion 必须选择真实模型', 'Fusion needs real models, not Fusion itself'))
    const group = catalog.groups.find(group => group.id === item.provider)
    const model = group?.models.find(model => model.id === item.model)
    if (!model) throw new Error(bi(`${role} 模型已不可用，请刷新后重选`, `The ${role} model is no longer available; refresh and choose again`))
    if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string'
      || !model.reasoning?.efforts.some(effort => effort.id === item.reasoningEffort))) {
      throw new Error(bi(`${role} 不支持所选推理强度`, `${role} does not support the selected reasoning level`))
    }
    return { provider: item.provider, model: item.model,
      ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort as string }) }
  }
  const cacheKeepalive = keepaliveChoice(raw.cacheKeepalive)
  const compactor = compactorChoice(raw.compactor)
  let outputTokens: PairChoice['outputTokens']
  if (raw.outputTokens !== undefined) {
    const value = raw.outputTokens
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([role, tokens]) => !['lead', 'worker'].includes(role)
        || !Number.isSafeInteger(tokens) || Number(tokens) < 1 || Number(tokens) > 128_000)) {
      throw new Error(bi('每次响应上限必须是 1–128000 的整数 Token 数', 'The per-response limit must be an integer of 1–128000 tokens'))
    }
    outputTokens = { ...value } as PairChoice['outputTokens']
  }
  return { lead: route('lead', raw.lead), worker: route('worker', raw.worker),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheKeepalive === undefined ? {} : { cacheKeepalive }),
    ...(compactor === undefined ? {} : { compactor: { ...compactor, route: route('压缩 · Compaction', compactor.route) } }) }
}

/** New sessions can opt into this Worker cap. Frozen sessions keep their saved profile. */
export const WORKER_IMPLEMENTATION_OUTPUT_TOKENS = 128_000

export function profileFromChoice(pair: PairChoice): Record<string, unknown> {
  const { outputTokens, ...routes } = pair
  const version = outputTokens?.worker === WORKER_IMPLEMENTATION_OUTPUT_TOKENS ? '0.1.0-worker-128k' : '0.1.0-faithful'
  return { schemaVersion: 1, id: 'fusion-auto', version, enabled: true, quality: 'experimental',
    ...routes, workerUpgradePath: [], dataPolicyId: 'native-host-workspace-policy', evidenceCampaignIds: [],
    ...(outputTokens === undefined ? {} : { context: Object.fromEntries(Object.entries(outputTokens)
      .map(([role, reserveOutputTokens]) => [role, { reserveOutputTokens }])) }) }
}

/** Product defaults; explicit legacy/benchmark profiles retain their old contract. */
export function modelProfileFromChoice(pair: PairChoice): Record<string, unknown> {
  const { outputTokens: _output, ...native } = pair
  return { ...profileFromChoice(native), version: '0.2.0-enforced-v3', interactionMode: 'model-like', workflowPolicy: 'enforced-v3' }
}

/** Keep existing default settings stable; expose explicit larger/smaller limits on reload. */
export function choiceFromProfile(profile: PairProfile): PairChoice {
  const outputTokens = Object.fromEntries((['lead', 'worker'] as const)
    .filter(role => profile.context[role].reserveOutputTokens !== 8_000)
    .map(role => [role, profile.context[role].reserveOutputTokens]))
  return { lead: profile.lead, worker: profile.worker,
    ...(profile.interactionMode !== 'model-like' && Object.keys(outputTokens).length ? { outputTokens } : {}),
    ...(profile.compactor === undefined ? {} : { compactor: profile.compactor }),
    ...(profile.cacheKeepalive === undefined ? {} : { cacheKeepalive: profile.cacheKeepalive }) }
}
