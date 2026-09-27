import type { PairProfile, PhysicalRoute } from '../contracts.js';
export interface PromptBundle {
    lead: string;
    worker: string;
    compact: string;
}
export interface ResolvedProfile {
    readonly profile: PairProfile;
    readonly prompts: PromptBundle;
}
export interface ProfileCatalog {
    readonly authorizedRoutes: readonly PhysicalRoute[];
}
export declare function promptDigests(prompts: PromptBundle): PairProfile['promptDigests'];
export declare function completeProfile(raw: Record<string, unknown>, prompts: PromptBundle): PairProfile;
export declare function resolveProfile(raw: Record<string, unknown>, prompts: PromptBundle, catalog: ProfileCatalog): ResolvedProfile;
export declare function loadJsonObject(path: string): Record<string, unknown>;
