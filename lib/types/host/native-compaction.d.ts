import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { PairProfile, PhysicalRoute } from '../contracts.js';
/**
 * Public llm/stream routing for the Host's mutable, one-shot summary envelope.
 * The Host still owns the compaction transaction and records this exact target.
 * Never replace a prepared AgentLoop request or start a nested model call.
 */
export declare function routeNativeCompaction(request: GenerateOptions, profile: PairProfile, effectiveRoute?: PhysicalRoute): void;
