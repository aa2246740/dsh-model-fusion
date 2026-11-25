import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmImageRequestPricing, LlmModelInfo, LlmResolvedModelInfo, ModelModality, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PhysicalRoute } from '../contracts.js';
import type { ResolvedProfile } from '../profile/resolve.js';
import type { FusionCoordinator } from './coordinator.js';
type AdapterImageRef = Parameters<LlmAdapter['imageRequestTarget']>[2];
type AdapterImageTarget = ReturnType<LlmAdapter['imageRequestTarget']>;
export declare const FUSION_PROVIDER = "dsh-model-fusion";
export declare const FUSION_MODEL = "auto";
export declare const isFusionSelection: (route: {
    provider?: string;
    model?: string;
} | undefined) => boolean;
/** Resolves the configured Lead's declared input modalities; undefined means unconfigured or unverifiable. */
export type LeadInputModalities = () => Promise<readonly ModelModality[] | undefined>;
export interface FusionAdapterHooks {
    readonly ctx: Context;
    readonly leadInputModalities?: LeadInputModalities;
    readonly coordinator: () => FusionCoordinator | undefined;
    readonly configuredLead?: () => PhysicalRoute | undefined;
}
/**
 * Whether an `llm/stream` request is the internal physical dispatch forwarded
 * by {@link FusionCatalogAdapter} after the outer `dsh-model-fusion/auto` pass
 * already ran Fusion's context, budget, usage, and keepalive observers.
 */
export declare function isForwardedFusionRequest(options: GenerateOptions): boolean;
/**
 * Capture raw pre-`adapterStream` `dsh-model-fusion/auto` requests so
 * {@link FusionCatalogAdapter} can forward the unprojected messages, tools,
 * `toolHistory`, and pre-Fusion `replayState` to Pass 2, letting the physical
 * adapter run tool-update, image, file, and `forAdapter` projection exactly once.
 */
export declare function installFusionRequestCapture(ctx: Context): () => void;
/**
 * Virtual model adapter for `dsh-model-fusion/auto`.
 * Keeps the user's native selection on `Fusion · 自动` (so the DSH model menu,
 * `FusionHint`, and `agent/request` selection-lock invariant stay intact) while
 * resolving capabilities and forwarding Lead streams to the active physical Lead.
 */
export declare class FusionCatalogAdapter extends LlmAdapter {
    #private;
    constructor(input?: LeadInputModalities | FusionAdapterHooks);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined;
    imageRequestTarget(provider: string, model: string, image: AdapterImageRef): AdapterImageTarget;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** Public native lifecycle integration. No model-menu replacement or Host patch. */
export declare function installNativeFusionSelection(ctx: Context, input: {
    coordinator(): FusionCoordinator | undefined;
    profile(): ResolvedProfile | undefined;
    selection(agent: Agent): PhysicalRoute | undefined;
}): () => void;
export {};
