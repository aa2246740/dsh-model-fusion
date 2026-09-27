import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PhysicalRoute, Role } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'
import { nativeRequestAgent } from './native-request.js'

/** Explicit bounded authorization when the native provider exposes no reliable money meter. */
export interface NativeSpendingAuthorization {
  schemaVersion: 1
  kind: 'native-fusion-requests'
  approved: true
  authorizationId: string
  approvedBy: string
  expiresAt: string
  routes: readonly PhysicalRoute[]
  maxNativeRequests: number
  maxReservedOutputTokens: number
  /** This cannot be represented as a hard dollar cap. */
  costPolicy: 'unknown-cost-acknowledged'
}

export function nativeAuthorization(raw: unknown): NativeSpendingAuthorization {
  const keys = new Set(['schemaVersion', 'kind', 'approved', 'authorizationId', 'approvedBy', 'expiresAt', 'routes',
    'maxNativeRequests', 'maxReservedOutputTokens', 'costPolicy'])
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.has(key))) {
    throw new Error('Unknown authorization fields; this authorization cannot enforce a money limit')
  }
  const value = raw as NativeSpendingAuthorization
  if (!value || value.schemaVersion !== 1 || value.kind !== 'native-fusion-requests' || value.approved !== true
    || !value.authorizationId?.trim() || !value.approvedBy?.trim()
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()
    || !Number.isSafeInteger(value.maxNativeRequests) || value.maxNativeRequests <= 0
    || !Number.isSafeInteger(value.maxReservedOutputTokens) || value.maxReservedOutputTokens <= 0
    || value.costPolicy !== 'unknown-cost-acknowledged' || !Array.isArray(value.routes) || !value.routes.length
    || value.routes.some(route => !route.provider?.trim() || !route.model?.trim())) {
    throw new Error('An unexpired, explicit native request spending authorization is required')
  }
  return structuredClone(value)
}

const UNLIMITED_HOURS = 24 * 365 * 100

/** Called only by explicit human settings actions (save or limits), never by a model tool. */
export function authorizeConfiguredPair(store: SqliteFusionStore, routes: readonly PhysicalRoute[], limits: unknown): NativeSpendingAuthorization {
  const input = limits as Record<string, unknown> | undefined
  if (!input || input.acknowledgeAccountUsage !== true || input.acknowledgeUnknownCost !== true) throw new Error('请确认使用模型账号额度，以及次数限制并非金额上限')
  // Saving a pair is the user's consent to use those accounts; caps are optional.
  // An omitted cap means none, so ordinary use never stalls on a limit the user did not choose.
  const integer = (key: string, max: number, fallback: number): number => {
    const value = input[key]
    if (value === undefined || value === null) return fallback
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${key} 超出允许范围`)
    return Number(value)
  }
  const auth = nativeAuthorization({ schemaVersion: 1, kind: 'native-fusion-requests', approved: true,
    authorizationId: randomUUID(), approvedBy: 'local-user-settings',
    expiresAt: new Date(Date.now() + integer('validHours', UNLIMITED_HOURS, UNLIMITED_HOURS) * 3600_000).toISOString(), routes,
    maxNativeRequests: integer('maxNativeRequests', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    maxReservedOutputTokens: integer('maxReservedOutputTokens', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    costPolicy: 'unknown-cost-acknowledged' })
  const prior = store.readDocument('settings:authorization')
  store.writeDocument('settings:authorization', prior?.revision ?? 0, auth)
  return auth
}

export class NativeRequestBudget {
  constructor(readonly store: SqliteFusionStore, readonly authorizationFile?: string) {}

  check(routes: readonly PhysicalRoute[]): NativeSpendingAuthorization {
    const raw = this.authorizationFile ? JSON.parse(readFileSync(this.authorizationFile, 'utf8'))
      : this.store.readDocument('settings:authorization')?.value
    if (!raw) throw new Error('请前往设置 → Fusion 启用调用额度')
    const auth = nativeAuthorization(raw)
    if (routes.some(route => !auth.routes.some(allowed => allowed.provider === route.provider && allowed.model === route.model))) {
      throw new Error('The frozen model configuration is outside this spending authorization')
    }
    const prior = this.store.readDocument(`budget:${auth.authorizationId}`)?.value as { digest?: string; requests?: number; reservedOutputTokens?: number } | undefined
    if (prior && prior.digest !== digestOf(auth)) throw new Error('Authorization changed under an existing id; record a new human authorization')
    if (Number(prior?.requests ?? 0) >= auth.maxNativeRequests || Number(prior?.reservedOutputTokens ?? 0) >= auth.maxReservedOutputTokens) throw new Error('Approved native request budget exhausted')
    return auth
  }

  install(ctx: Context, owner: (agent: Agent) => { binding: SessionBinding; role: Role } | undefined,
    onBlocked?: (binding: SessionBinding, error: unknown) => void): () => void {
    const budget = this
    return ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
      const agent = nativeRequestAgent(ctx, request), binding = agent && owner(agent)
      if (binding) {
        try { budget.reserve({ provider: request.provider, model: request.model }, request.maxTokens ?? 0) }
        catch (error) { onBlocked?.(binding.binding, error); throw error }
      }
      yield* next()
    }, { prepend: true })
  }

  reserve(route: PhysicalRoute, maxOutputTokens: number): void {
    const auth = this.check([route])
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error('A bounded output reservation is required')
    const key = `budget:${auth.authorizationId}`, prior = this.store.readDocument(key)
    const row = prior?.value as { requests: number; reservedOutputTokens: number } | undefined
    const requests = (row?.requests ?? 0) + 1, reservedOutputTokens = (row?.reservedOutputTokens ?? 0) + maxOutputTokens
    if (requests > auth.maxNativeRequests || reservedOutputTokens > auth.maxReservedOutputTokens) throw new Error('This request exceeds the approved request/output budget')
    // Unknown billing retains the reservation, including aborted requests.
    this.store.writeDocument(key, prior?.revision ?? 0, { schemaVersion: 1, digest: digestOf(auth), requests, reservedOutputTokens,
      lastReservationId: randomUUID(), actualBilledUsd: null, apiEquivalentUsd: null, maximumDollarCost: null })
  }
}
