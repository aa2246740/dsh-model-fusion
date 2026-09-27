export type Count = {
    state: 'known';
    tokens: number;
} | {
    state: 'unknown';
} | {
    state: 'not_applicable';
};
export declare const known: (tokens: number) => Count;
export declare const unknown: () => Count;
export declare const na: () => Count;
export type CacheWrites = {
    kind: 'not_applicable';
} | {
    kind: 'unknown';
} | {
    kind: 'aggregate';
    tokens: Count;
    rateKey: string;
} | {
    kind: 'details';
    buckets: Readonly<Record<string, {
        tokens: Count;
        rateKey: string;
    }>>;
};
export interface CanonicalBill {
    uncachedInput: Count;
    cacheRead: Count;
    output: Count;
    cacheWrite: CacheWrites;
    reasoning: {
        kind: 'included' | 'separate' | 'unknown' | 'not_applicable';
        tokens: Count;
    };
}
export interface UsageRequestKey {
    provider: string;
    model: string;
    requestId: string;
    attemptId: string;
    contractDigest: string;
}
export interface UsageObservation {
    id: string;
    key: UsageRequestKey;
    sequence: number;
    mode: 'snapshot' | 'delta' | 'final';
    bill: CanonicalBill;
}
export interface UsageLedgerV2 {
    schemaVersion: 2;
    key: UsageRequestKey;
    observations: readonly UsageObservation[];
}
export interface UsageProjection {
    bill?: CanonicalBill;
    authority: 'none' | 'provisional' | 'final';
}
export declare function newLedger(key: UsageRequestKey): UsageLedgerV2;
export declare function projectLedger(ledger: UsageLedgerV2): UsageProjection;
export declare function ingestObservation(ledger: UsageLedgerV2, observation: UsageObservation): UsageLedgerV2;
export declare function ingestDurable(ledger: UsageLedgerV2, observation: UsageObservation): UsageLedgerV2;
export declare function restoreLedger(raw: unknown): UsageLedgerV2;
export declare function splitInput(total: Count, cached: Count, includesCache: boolean | null): Count;
export declare const observationDigest: (observation: UsageObservation) => string;
