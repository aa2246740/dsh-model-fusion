import type { NormalizedUsage, UsdDecimal } from '../contracts.js';
import { type UsageObservation, type UsageRequestKey } from './ledger.js';
export interface RawUsage {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    cacheWriteByTtl?: Readonly<Record<string, number | null>>;
    reasoningTokens?: number | null;
    /** When true, inputTokens already includes cacheReadTokens. */
    inputIncludesCacheRead?: boolean;
    /** When true, outputTokens already includes reasoningTokens. */
    outputIncludesReasoning?: boolean;
}
export interface PriceCard {
    digest: string;
    uncachedInputPerMillion?: string | null;
    cacheReadPerMillion?: string | null;
    cacheWritePerMillion?: Readonly<Record<string, string | null>>;
    outputPerMillion?: string | null;
    reasoningPerMillion?: string | null;
}
export type UsageObservationKind = 'partial' | 'final';
export interface UsageObservationMeta {
    requestId?: string;
    source?: UsageObservationKind;
    sequence?: number;
    cumulative?: boolean;
    observationId?: string;
}
export type UsagePriceStatus = 'complete' | 'incomplete' | 'unknown';
export interface UsagePrice {
    status: UsagePriceStatus;
    /** Complete total only. Never a partial stand-in for ranking. */
    totalUsd: UsdDecimal | null;
    /** Lower bound of priced known buckets. Not a substitute total. */
    observedUsd: UsdDecimal | null;
    reasons: readonly string[];
}
export declare function normalizeUsage(raw: RawUsage): NormalizedUsage;
export declare function observationFromNormalized(usage: NormalizedUsage, key: UsageRequestKey, meta: UsageObservationMeta & {
    id?: string;
}): UsageObservation;
/**
 * Retired. Persist UsageLedgerV2 and quoteLedger(). A NormalizedUsage projection
 * is not enough history to replay a request bill.
 */
export declare function mergeUsageObservations(..._args: unknown[]): never;
export declare function priceUsage(usage: NormalizedUsage, card: PriceCard | undefined): UsagePrice;
export declare function apiEquivalentUsd(usage: NormalizedUsage, card: PriceCard | undefined): UsdDecimal | null;
