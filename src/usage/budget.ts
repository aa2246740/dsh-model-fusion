import { FusionError, SPEND_UNAUTHORIZED } from '../errors.js'
import type { UsdDecimal } from '../contracts.js'

export interface SpendingAuthorization {
  schemaVersion: 1
  approved: boolean
  authorizationId: string | null
  currency: string
  maximumTotal: string | null
  allowedModels: readonly string[]
  expiresAt: string | null
  approvedBy: string | null
}

export interface Reservation {
  readonly authorizationId: string
  readonly reserved: UsdDecimal
  readonly remaining: UsdDecimal | null
}

export class BudgetLedger {
  #spent = 0
  #reserved = 0

  constructor(readonly authorization: SpendingAuthorization) {}

  assertAuthorized(model?: string): void {
    if (!this.authorization.approved || !this.authorization.authorizationId) {
      throw new FusionError(SPEND_UNAUTHORIZED, 'no approved spending authorization')
    }
    if (model && this.authorization.allowedModels.length && !this.authorization.allowedModels.includes(model)) {
      throw new FusionError(SPEND_UNAUTHORIZED, `model ${model} is not on the authorization allowlist`)
    }
  }

  reserve(estimatedUsd: number, model?: string): Reservation {
    this.assertAuthorized(model)
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new TypeError('estimatedUsd must be finite and nonnegative')
    const cap = this.authorization.maximumTotal === null ? null : Number(this.authorization.maximumTotal)
    if (cap !== null && this.#spent + this.#reserved + estimatedUsd > cap) {
      throw new FusionError(SPEND_UNAUTHORIZED, 'budget reservation would exceed maximumTotal')
    }
    this.#reserved += estimatedUsd
    const remaining = cap === null ? null : (cap - this.#spent - this.#reserved).toString()
    return {
      authorizationId: this.authorization.authorizationId!,
      reserved: estimatedUsd.toString() as UsdDecimal,
      remaining: remaining as UsdDecimal | null,
    }
  }

  settle(reserved: Reservation, actualUsd: number | null): void {
    const reservedN = Number(reserved.reserved)
    if (actualUsd === null) {
      return
    }
    this.#reserved = Math.max(0, this.#reserved - reservedN)
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new TypeError('actualUsd must be finite and nonnegative')
    const cap = this.authorization.maximumTotal === null ? null : Number(this.authorization.maximumTotal)
    if (cap !== null && this.#spent + actualUsd > cap) {
      throw new FusionError(SPEND_UNAUTHORIZED, 'actual spend would exceed maximumTotal')
    }
    this.#spent += actualUsd
  }

  get reserved(): number {
    return this.#reserved
  }

  get spent(): number {
    return this.#spent
  }
}

export function loadSpendingAuthorization(raw: unknown): SpendingAuthorization {
  const value = raw as SpendingAuthorization
  if (!value || value.schemaVersion !== 1) throw new TypeError('unsupported spending authorization schema')
  return {
    schemaVersion: 1,
    approved: value.approved === true,
    authorizationId: value.authorizationId ?? null,
    currency: value.currency ?? 'USD',
    maximumTotal: value.maximumTotal ?? null,
    allowedModels: Array.isArray(value.allowedModels) ? value.allowedModels : [],
    expiresAt: value.expiresAt ?? null,
    approvedBy: value.approvedBy ?? null,
  }
}
