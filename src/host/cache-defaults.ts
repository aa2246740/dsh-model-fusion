/**
 * Default prompt-cache behaviour for the models most people pair in Fusion, from each provider's official
 * documentation. Matching uses the model id (stable across DSH setups), never the route name, except for the
 * routes of this project's own OAuth plugins, whose billing we know. Everything here is a default: the user's
 * per-model setting always wins, and the runtime can shorten an interval it observes to be too long.
 */

export const CACHE_DEFAULTS_CHECKED = '2026-09-27'
/** Safe for every provider documented here (the shortest documented lifetime is 5 minutes). */
export const GENERIC_INTERVAL_SECONDS = 285

export type CacheMode = 'auto' | 'on' | 'off'

export interface CacheFamily {
  id: string
  label: string
  match: RegExp
  /** Official lifetime text as documented (not a guarantee; caches are best-effort). */
  lifetime: { zh: string; en: string }
  /** Cached input price relative to uncached input, as documented. */
  discount: string
  keepalive: CacheMode
  intervalSeconds: number
  docs: string
}

export const CACHE_FAMILIES: readonly CacheFamily[] = [
  { id: 'openai', label: 'OpenAI', match: /^(gpt-|o\d|codex|chatgpt)/i, discount: '1/10', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '空闲 5–10 分钟，最长 1 小时；部分新模型至少 30 分钟（订阅通道实测更短）', en: '5–10 min idle, up to 1 h; some newer models ≥ 30 min (shorter observed via subscriptions)' },
    docs: 'https://developers.openai.com/api/docs/guides/prompt-caching' },
  { id: 'anthropic', label: 'Anthropic', match: /^claude/i, discount: '1/10', keepalive: 'auto', intervalSeconds: 270,
    lifetime: { zh: '5 分钟，每次命中重新计时（可选 1 小时）', en: '5 min, refreshed on each hit (1 h option)' },
    docs: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching' },
  { id: 'google', label: 'Google', match: /^gemini/i, discount: '1/10', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '隐式缓存自动，时长未公布', en: 'implicit, lifetime not published' },
    docs: 'https://ai.google.dev/gemini-api/docs/caching' },
  { id: 'deepseek', label: 'DeepSeek', match: /^deepseek/i, discount: '1/10–1/50', keepalive: 'off', intervalSeconds: 285,
    lifetime: { zh: '硬盘缓存，通常保留几小时到几天（等待期间不会过期，无需保活）', en: 'disk cache, hours to days (no keepalive needed)' },
    docs: 'https://api-docs.deepseek.com/guides/kv_cache/' },
  { id: 'xai', label: 'xAI', match: /^grok/i, discount: '≈1/6', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '自动，时长未公布，内存紧张时可能被清除', en: 'automatic, lifetime not published, evicted under memory pressure' },
    docs: 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching' },
  { id: 'zhipu', label: 'Z.AI / 智谱', match: /^glm/i, discount: '≈1/5', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '自动，时长未公布', en: 'automatic, lifetime not published' },
    docs: 'https://docs.bigmodel.cn/cn/guide/capabilities/cache' },
  { id: 'moonshot', label: 'Moonshot / Kimi', match: /^kimi|^moonshot/i, discount: '1/10', keepalive: 'auto', intervalSeconds: 270,
    lifetime: { zh: '默认 5 分钟，每次命中重新计时（可选 1 小时）', en: '5 min default, refreshed on each hit (1 h tier)' },
    docs: 'https://platform.moonshot.ai/docs/pricing/chat-k3' },
  { id: 'alibaba', label: 'Alibaba / Qwen', match: /^qwen/i, discount: '1/5', keepalive: 'auto', intervalSeconds: 270,
    lifetime: { zh: '隐式缓存由系统管理；显式缓存 5 分钟', en: 'implicit cache system-managed; explicit cache 5 min' },
    docs: 'https://help.aliyun.com/zh/model-studio/context-cache' },
  { id: 'xiaomi', label: 'Xiaomi MiMo', match: /^mimo/i, discount: '≈1/120', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '自动，时长未公布', en: 'automatic, lifetime not published' },
    docs: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go' },
  { id: 'stepfun', label: 'StepFun', match: /^step/i, discount: '1/5', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '自动，时长未公布', en: 'automatic, lifetime not published' },
    docs: 'https://platform.stepfun.com/docs/guide/prompt_cache' },
  { id: 'meta', label: 'Meta Muse', match: /^muse/i, discount: '≈1/8', keepalive: 'auto', intervalSeconds: 285,
    lifetime: { zh: '自动；可申请 24 小时保留但不保证', en: 'automatic; 24 h retention is a hint, not a guarantee' },
    docs: 'https://dev.meta.ai/docs/pricing-rate-limits' },
  { id: 'minimax', label: 'MiniMax', match: /^minimax/i, discount: '1/5', keepalive: 'auto', intervalSeconds: 270,
    lifetime: { zh: '5 分钟，每次命中重新计时', en: '5 min, refreshed on each hit' },
    docs: 'https://platform.minimax.io/docs/api-reference/text-prompt-caching' },
]

/** Routes of this project's OAuth plugins (dsh-oauth-login, dsh-antigravity-oauth): billing we know. */
export interface RouteBilling { match: RegExp; label: string; keepalive: CacheMode; reason: { zh: string; en: string } }
export const OWN_ROUTES: readonly RouteBilling[] = [
  { match: /^pi-zai-coding/, label: 'GLM Coding Plan', keepalive: 'off',
    reason: { zh: '按请求次数计额度，保活会占用次数', en: 'quota counts requests; keepalive pings would use it' } },
  { match: /^pi-kimi-coding/, label: 'Kimi Code', keepalive: 'off',
    reason: { zh: '订阅按请求次数计额度', en: 'subscription quota counts requests' } },
  { match: /^pi-github-copilot/, label: 'GitHub Copilot', keepalive: 'off',
    reason: { zh: '每次请求都算一次高级请求', en: 'every request counts as a premium request' } },
  { match: /^agy-/, label: 'Antigravity', keepalive: 'off',
    reason: { zh: '按请求次数限额', en: 'request-count limits' } },
  ...([[/^pi-openai-codex/, 'ChatGPT (Codex)'], [/^pi-anthropic/, 'Claude'], [/^pi-xai/, 'xAI'], [/^pi-openrouter/, 'OpenRouter']] as const)
    .map(([match, label]): RouteBilling => ({ match, label, keepalive: 'auto',
      reason: { zh: '按用量计，缓存命中能省额度', en: 'usage-based; cache hits save quota' } })),
]

export interface CacheDefaults {
  keepalive: CacheMode
  intervalSeconds: number
  source: 'route' | 'family' | 'generic'
  family?: CacheFamily
  route?: RouteBilling
}

/** Defaults for one physical route; the model id selects the family, our own routes set the billing mode. */
export function cacheDefaults(provider: string, model: string): CacheDefaults {
  const family = CACHE_FAMILIES.find(item => item.match.test(model))
  const route = OWN_ROUTES.find(item => item.match.test(provider))
  if (route) return { keepalive: route.keepalive, intervalSeconds: family?.intervalSeconds ?? GENERIC_INTERVAL_SECONDS, source: 'route', family, route }
  if (family) return { keepalive: family.keepalive, intervalSeconds: family.intervalSeconds, source: 'family', family }
  return { keepalive: 'auto', intervalSeconds: GENERIC_INTERVAL_SECONDS, source: 'generic' }
}
