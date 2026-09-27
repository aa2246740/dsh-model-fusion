import { bi } from '../bilingual.js'
import type { PairProfile, PhysicalRoute } from '../contracts.js'

/** A separate summary model is never inferred from a provider name or enabled by default. */
export function compactorChoice(value: unknown): PairProfile['compactor'] {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(bi('压缩模型配置无效', 'Invalid compaction model setting'))
  const raw = value as Record<string, unknown>, route = raw.route as Record<string, unknown> | undefined
  if (Object.keys(raw).some(key => key !== 'route' && key !== 'maxOutputTokens')
    || !route || typeof route !== 'object' || Array.isArray(route)
    || Object.keys(route).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))
    || typeof route.provider !== 'string' || !route.provider.trim()
    || typeof route.model !== 'string' || !route.model.trim()
    || (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort.trim()))
    || !Number.isSafeInteger(raw.maxOutputTokens) || Number(raw.maxOutputTokens) < 1 || Number(raw.maxOutputTokens) > 128_000) {
    throw new Error(bi('请选择压缩模型，并设置 1–128000 的输出 Token 上限', 'Choose a compaction model and an output limit of 1–128000 tokens'))
  }
  return { route: { provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as string }) },
    maxOutputTokens: Number(raw.maxOutputTokens) }
}

/** All physical routes in a frozen configuration share the same explicit spending authorization. */
export function profileRoutes(profile: Pick<PairProfile, 'lead' | 'worker' | 'compactor'>): PhysicalRoute[] {
  return [profile.lead, profile.worker, ...(profile.compactor ? [profile.compactor.route] : [])]
}
