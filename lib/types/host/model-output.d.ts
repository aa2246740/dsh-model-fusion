import type { Context } from '@deepseek-ai/cordis';
/**
 * Output limits come only from the public model metadata DSH discloses for the route (context window and
 * the adapter's default max tokens). No route or model names are special-cased: route names differ between
 * installations, and a guessed cap would be wrong for someone else's setup.
 */
export interface ModelOutputLimits {
    contextWindow: number;
    defaultMaxTokens?: number;
    testedOutputCap?: number;
}
/** Public model metadata only; resolving limits does not start a model turn. */
export declare function resolveModelOutputLimits(ctx: Context, provider: string, model: string): Promise<ModelOutputLimits>;
