import type { PairProfile, PhysicalRoute } from '../contracts.js';
export interface PairChoice {
    lead: PhysicalRoute;
    worker: PhysicalRoute;
    outputTokens?: Partial<Record<'lead' | 'worker', number>>;
    cacheKeepalive?: PairProfile['cacheKeepalive'];
    compactor?: PairProfile['compactor'];
}
export interface SettingsCatalog {
    groups: readonly {
        id: string;
        name: string;
        models: readonly {
            id: string;
            name: string;
            reasoning?: {
                efforts: readonly {
                    id: string;
                    name: string;
                }[];
                defaultEffort?: string;
            };
        }[];
    }[];
}
/** Saved Lead route from a raw settings or profile document, or undefined when unconfigured or pointed at Fusion itself. */
export declare function savedLeadRoute(value: unknown): {
    provider: string;
    model: string;
} | undefined;
/** Configuration chooses registered physical models; it cannot create adapters. */
export declare function validatePairChoice(value: unknown, catalog: SettingsCatalog): PairChoice;
/** New sessions can opt into this Worker cap. Frozen sessions keep their saved profile. */
export declare const WORKER_IMPLEMENTATION_OUTPUT_TOKENS = 128000;
export declare function profileFromChoice(pair: PairChoice): Record<string, unknown>;
/** Product defaults; explicit legacy/benchmark profiles retain their old contract. */
export declare function modelProfileFromChoice(pair: PairChoice): Record<string, unknown>;
/** Keep existing default settings stable; expose explicit larger/smaller limits on reload. */
export declare function choiceFromProfile(profile: PairProfile): PairChoice;
