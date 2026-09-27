import type { UsdDecimal } from '../contracts.js';
export interface SpendingAuthorization {
    schemaVersion: 1;
    approved: boolean;
    authorizationId: string | null;
    currency: string;
    maximumTotal: string | null;
    allowedModels: readonly string[];
    expiresAt: string | null;
    approvedBy: string | null;
}
export interface Reservation {
    readonly authorizationId: string;
    readonly reserved: UsdDecimal;
    readonly remaining: UsdDecimal | null;
}
export declare class BudgetLedger {
    #private;
    readonly authorization: SpendingAuthorization;
    constructor(authorization: SpendingAuthorization);
    assertAuthorized(model?: string): void;
    reserve(estimatedUsd: number, model?: string): Reservation;
    settle(reserved: Reservation, actualUsd: number | null): void;
    get reserved(): number;
    get spent(): number;
}
export declare function loadSpendingAuthorization(raw: unknown): SpendingAuthorization;
