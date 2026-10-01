/**
 * Default prompt-cache behaviour for the models most people pair in Fusion, from each provider's official
 * documentation. Matching uses the model id (stable across DSH setups), never the route name, except for the
 * routes of this project's own OAuth plugins, whose billing we know. Everything here is a default: the user's
 * per-model setting always wins, and the runtime can shorten an interval it observes to be too long.
 */
export declare const CACHE_DEFAULTS_CHECKED = "2026-09-27";
/** Safe for every provider documented here (the shortest documented lifetime is 5 minutes). */
export declare const GENERIC_INTERVAL_SECONDS = 285;
export type CacheMode = 'auto' | 'on' | 'off';
export interface CacheFamily {
    id: string;
    label: string;
    match: RegExp;
    /** Official lifetime text as documented (not a guarantee; caches are best-effort). */
    lifetime: {
        zh: string;
        en: string;
    };
    /** Cached input price relative to uncached input, as documented. */
    discount: string;
    keepalive: CacheMode;
    intervalSeconds: number;
    docs: string;
}
export declare const CACHE_FAMILIES: readonly CacheFamily[];
/** Routes of this project's OAuth plugins (dsh-oauth-login, dsh-antigravity-oauth): billing we know. */
export interface RouteBilling {
    match: RegExp;
    label: string;
    keepalive: CacheMode;
    reason: {
        zh: string;
        en: string;
    };
    /** Interval measured on this route; overrides the model family default. */
    intervalSeconds?: number;
}
export declare const OWN_ROUTES: readonly RouteBilling[];
export interface CacheDefaults {
    keepalive: CacheMode;
    intervalSeconds: number;
    source: 'route' | 'family' | 'generic';
    family?: CacheFamily;
    route?: RouteBilling;
}
/** Defaults for one physical route; the model id selects the family, our own routes set the billing mode. */
export declare function cacheDefaults(provider: string, model: string): CacheDefaults;
