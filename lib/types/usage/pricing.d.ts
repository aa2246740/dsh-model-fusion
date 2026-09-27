import { type UsageLedgerV2 } from './ledger.js';
export interface PriceRates {
    input?: string;
    cachedInput?: string;
    output?: string;
    /** Explicit separate-reasoning rate; no assumed relationship to output price. */
    reasoning?: string;
    cacheWrite?: Readonly<Record<string, string>>;
}
export interface RequestQuote {
    authority: 'none' | 'provisional' | 'final';
    status: 'unknown' | 'provisional' | 'incomplete' | 'complete';
    totalUsd: string | null;
    estimateUsd: string | null;
    priceCardDigest: string;
    missing: string[];
}
export declare function quoteLedger(ledger: UsageLedgerV2, rates: PriceRates, priceCardDigest?: import("../contracts.js").Digest): RequestQuote;
