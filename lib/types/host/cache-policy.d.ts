import type { Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import { type CacheDefaults, type CacheMode } from './cache-defaults.js';
/** The user's choice for one physical model route; absent fields fall back to learned/default values. */
export interface ModelCacheSetting {
    mode?: CacheMode;
    intervalSeconds?: number;
}
/** One model request that followed a wait: the evidence the policy learns from and the settings page shows. */
export interface CacheSample {
    at: string;
    gapSeconds: number;
    ping: boolean;
    hit: boolean;
    cacheRead: number;
    input: number;
}
export interface ModelCacheStats {
    schemaVersion: 1;
    provider: string;
    model: string;
    samples: CacheSample[];
    totals: {
        /** Real requests after a wait of at least WAIT_SECONDS, and how many still found their prefix cached. */
        waits: number;
        waitHits: number;
        /** Keepalive pings and the tokens they read (mostly at the cache price). */
        pings: number;
        pingHits: number;
        pingTokens: number;
        /** Prefix tokens served from cache after a wait, and tokens resent uncached after a wait. */
        keptWarmTokens: number;
        resentTokens: number;
    };
    /** Interval shortened after pings kept missing (never lengthened automatically). */
    learnedIntervalSeconds?: number;
    updatedAt: string;
}
export interface EffectiveCachePolicy {
    mode: CacheMode;
    intervalSeconds: number;
    modeSource: 'user' | 'pair' | 'role' | CacheDefaults['source'];
    intervalSource: 'user' | 'learned' | CacheDefaults['source'];
    defaults: CacheDefaults;
}
/** A request counts as a wait when this long passed since the previous request of the same agent. */
export declare const WAIT_SECONDS = 120;
/** A request reused its prefix when most of its input came from the cache. */
export declare const cacheHit: (cacheRead: number, input: number) => boolean;
export declare const clampInterval: (seconds: number) => number;
export declare class CachePolicy {
    readonly store: SqliteFusionStore;
    constructor(store: SqliteFusionStore);
    setting(provider: string, model: string): ModelCacheSetting | undefined;
    /** Save or clear (null) the user's choice; invalid values are refused, not coerced. */
    save(provider: string, model: string, setting: ModelCacheSetting | null): void;
    stats(provider: string, model: string): ModelCacheStats | undefined;
    /**
     * Record a request that followed a wait (or any keepalive ping). Pings that keep missing at the current
     * interval shorten it by a quarter: a too-long interval wastes every ping, a too-short one only costs extra
     * cheap reads, so the rule only ever moves toward safety. Lengthening is left to the user (see suggestion).
     */
    observe(provider: string, model: string, sample: Omit<CacheSample, 'at'>, currentIntervalSeconds: number): void;
    /**
     * User setting > pair profile (older explicit choice) > learned interval > our own route's billing default >
     * model family default > generic. The Worker defaults to off: it rarely waits long enough to need pings.
     */
    resolve(provider: string, model: string, role: Role, pairChoice?: boolean | 'auto'): EffectiveCachePolicy;
    /** Suggest a longer interval only on repeated evidence: real waits that still hit well beyond the interval. */
    suggestion(provider: string, model: string, intervalSeconds: number): number | undefined;
    /** Every route the plugin has evidence or a setting for, plus the given routes (the configured pair). */
    routes(extra?: readonly {
        provider: string;
        model: string;
    }[]): {
        provider: string;
        model: string;
    }[];
}
type Route = {
    provider: string;
    model: string;
};
/** One row of the settings page: what applies, why, what the defaults say, and what was observed. */
export declare function cacheView(policy: CachePolicy, pair?: {
    lead: Route;
    worker: Route;
}, pairChoice?: {
    lead?: boolean | 'auto';
    worker?: boolean | 'auto';
}): {
    provider: string;
    model: string;
    role: Role | undefined;
    mode: CacheMode;
    intervalSeconds: number;
    modeSource: "user" | "role" | "route" | "family" | "generic" | "pair";
    intervalSource: "user" | "route" | "family" | "generic" | "learned";
    setting: ModelCacheSetting;
    defaults: {
        route?: {
            label: string;
            reason: {
                zh: string;
                en: string;
            };
        } | undefined;
        family?: {
            label: string;
            lifetime: {
                zh: string;
                en: string;
            };
            discount: string;
            docs: string;
        } | undefined;
        mode: CacheMode;
        intervalSeconds: number;
        source: "route" | "family" | "generic";
    };
    totals: {
        /** Real requests after a wait of at least WAIT_SECONDS, and how many still found their prefix cached. */
        waits: number;
        waitHits: number;
        /** Keepalive pings and the tokens they read (mostly at the cache price). */
        pings: number;
        pingHits: number;
        pingTokens: number;
        /** Prefix tokens served from cache after a wait, and tokens resent uncached after a wait. */
        keptWarmTokens: number;
        resentTokens: number;
    } | null;
    learnedIntervalSeconds: number | null;
    suggestion: number | null;
    recent: {
        gapSeconds: number;
        ping: boolean;
        hit: boolean;
    }[];
}[];
export {};
