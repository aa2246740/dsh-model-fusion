import { readFileSync } from 'node:fs'
import type { Digest, PairProfile, PhysicalRoute, RoleContextPolicy } from '../contracts.js'
import { digestOf, sha256Hex } from '../digest.js'
import { FusionError, PROFILE_UNAVAILABLE } from '../errors.js'
import { keepaliveChoice } from './keepalive.js'
import { compactorChoice, profileRoutes } from './compactor.js'

const PLACEHOLDERS = new Set(['__AUTHORIZED_PROVIDER__', '__EXACT_MODEL_ID__', '__EXACT_WORKER_ID__', '__EXISTING_PROJECT_POLICY__'])

export interface PromptBundle {
  lead: string
  worker: string
  compact: string
}

export interface ResolvedProfile {
  readonly profile: PairProfile
  readonly prompts: PromptBundle
}

export interface ProfileCatalog {
  readonly authorizedRoutes: readonly PhysicalRoute[]
}

function isPlaceholder(route: PhysicalRoute): boolean {
  return PLACEHOLDERS.has(route.provider) || PLACEHOLDERS.has(route.model)
}

function asPolicy(raw: RoleContextPolicy | undefined, fallback: RoleContextPolicy): RoleContextPolicy {
  const policy = {
    targetInputTokens: raw?.targetInputTokens ?? fallback.targetInputTokens,
    reserveOutputTokens: raw?.reserveOutputTokens ?? fallback.reserveOutputTokens,
    minSafetyTokens: raw?.minSafetyTokens ?? fallback.minSafetyTokens,
    safetyFraction: raw?.safetyFraction ?? fallback.safetyFraction,
    compactToFraction: raw?.compactToFraction ?? fallback.compactToFraction,
    evidenceReadTokens: raw?.evidenceReadTokens ?? fallback.evidenceReadTokens,
    maxToolVisibleTokens: raw?.maxToolVisibleTokens ?? fallback.maxToolVisibleTokens,
  }
  for (const key of ['targetInputTokens', 'reserveOutputTokens', 'evidenceReadTokens', 'maxToolVisibleTokens'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new FusionError(PROFILE_UNAVAILABLE, `Invalid context policy: ${key}`)
  }
  if (!Number.isSafeInteger(policy.minSafetyTokens) || policy.minSafetyTokens < 0
    || !Number.isFinite(policy.safetyFraction) || policy.safetyFraction < 0 || policy.safetyFraction >= 1
    || !Number.isFinite(policy.compactToFraction) || policy.compactToFraction <= 0 || policy.compactToFraction >= 1) {
    throw new FusionError(PROFILE_UNAVAILABLE, 'Invalid context safety or compaction policy')
  }
  return policy
}

const LEAD_DEFAULT: RoleContextPolicy = {
  // The final guard always intersects this soft target with the registered
  // physical model window, output reservation and safety margin. A fixed 32k
  // default can reject the real Host's system prompt/tools before its first
  // request; do not impose an undocumented smaller window by default.
  targetInputTokens: Number.MAX_SAFE_INTEGER,
  reserveOutputTokens: 8_000,
  minSafetyTokens: 2_048,
  safetyFraction: 0.05,
  compactToFraction: 0.5,
  evidenceReadTokens: 4_000,
  maxToolVisibleTokens: 6_000,
}

const WORKER_DEFAULT: RoleContextPolicy = {
  ...LEAD_DEFAULT,
  compactToFraction: 0.55,
  evidenceReadTokens: 8_000,
  maxToolVisibleTokens: 8_000,
}

export function promptDigests(prompts: PromptBundle): PairProfile['promptDigests'] {
  return {
    lead: sha256Hex(prompts.lead),
    worker: sha256Hex(prompts.worker),
    compact: sha256Hex(prompts.compact),
  }
}

export function completeProfile(raw: Record<string, unknown>, prompts: PromptBundle): PairProfile {
  const lead = raw.lead as PhysicalRoute
  const worker = raw.worker as PhysicalRoute
  const context = (raw.context ?? {}) as Partial<PairProfile['context']>
  const promptHash = promptDigests(prompts)
  const cacheKeepalive = keepaliveChoice(raw.cacheKeepalive)
  const compactor = compactorChoice(raw.compactor)
  if (raw.interactionMode !== undefined && raw.interactionMode !== 'model-like') throw new Error('Unknown Fusion interaction mode')
  if (raw.workflowPolicy !== undefined && (!['enforced-v1', 'enforced-v2', 'enforced-v3'].includes(String(raw.workflowPolicy)) || raw.interactionMode !== 'model-like')) throw new Error('Unknown Fusion workflow policy')
  const profile: PairProfile = {
    schemaVersion: 1,
    id: String(raw.id),
    version: String(raw.version),
    digest: '' as Digest,
    enabled: raw.enabled === true,
    quality: (raw.quality as PairProfile['quality']) ?? 'experimental',
    ...(raw.interactionMode === 'model-like' ? { interactionMode: 'model-like' as const } : {}),
    ...(raw.workflowPolicy === 'enforced-v1' || raw.workflowPolicy === 'enforced-v2' || raw.workflowPolicy === 'enforced-v3' ? { workflowPolicy: raw.workflowPolicy } : {}),
    lead,
    worker,
    workerUpgradePath: (raw.workerUpgradePath as PhysicalRoute[]) ?? [],
    promptDigests: promptHash,
    context: {
      lead: asPolicy(context.lead, LEAD_DEFAULT),
      worker: asPolicy(context.worker, WORKER_DEFAULT),
    },
    dataPolicyId: String(raw.dataPolicyId ?? ''),
    evidenceCampaignIds: (raw.evidenceCampaignIds as string[]) ?? [],
    ...(cacheKeepalive === undefined ? {} : { cacheKeepalive }),
    ...(compactor === undefined ? {} : { compactor }),
  }
  return { ...profile, digest: digestOf(profile) }
}

export function resolveProfile(raw: Record<string, unknown>, prompts: PromptBundle, catalog: ProfileCatalog): ResolvedProfile {
  const profile = completeProfile(raw, prompts)
  if (!profile.enabled) {
    throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} is disabled`)
  }
  if (profileRoutes(profile).some(isPlaceholder) || PLACEHOLDERS.has(profile.dataPolicyId)) {
    throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} still has placeholder routes`)
  }
  const authorized = (route: PhysicalRoute) =>
    catalog.authorizedRoutes.some(item => item.provider === route.provider && item.model === route.model)
  if (!profileRoutes(profile).every(authorized)) {
    throw new FusionError(PROFILE_UNAVAILABLE, `profile ${profile.id} routes are not authorized on this Host`)
  }
  return { profile, prompts }
}

export function loadJsonObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}
