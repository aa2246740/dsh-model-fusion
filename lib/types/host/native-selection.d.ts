import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, ModelModality, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PhysicalRoute } from '../contracts.js';
import type { ResolvedProfile } from '../profile/resolve.js';
import type { FusionCoordinator } from './coordinator.js';
export declare const FUSION_PROVIDER = "dsh-model-fusion";
export declare const FUSION_MODEL = "auto";
export declare const isFusionSelection: (route: {
    provider?: string;
    model?: string;
} | undefined) => boolean;
/** Resolves the configured Lead's declared input modalities; undefined means unconfigured or unverifiable. */
export type LeadInputModalities = () => Promise<readonly ModelModality[] | undefined>;
/** Catalog-only local adapter; the native request is physically routed before dispatch. */
export declare class FusionCatalogAdapter extends LlmAdapter {
    private readonly leadInputModalities?;
    constructor(leadInputModalities?: LeadInputModalities | undefined);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(_options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** Public native lifecycle integration. No model-menu replacement or Host patch. */
export declare function installNativeFusionSelection(ctx: Context, input: {
    coordinator(): FusionCoordinator | undefined;
    profile(): ResolvedProfile | undefined;
    selection(agent: Agent): PhysicalRoute | undefined;
}): () => void;
