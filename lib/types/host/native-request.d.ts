import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/** Auxiliary native calls may carry a session without an active Agent turn. */
export declare function nativeRequestAgent(ctx: Context, request: GenerateOptions): Agent | undefined;
