import type { Context } from '@deepseek-ai/cordis'
import { fittedOutputReservation } from '../context/guard.js'

/**
 * Output limits come only from the public model metadata DSH discloses for the route (context window and
 * the adapter's default max tokens). No route or model names are special-cased: route names differ between
 * installations, and a guessed cap would be wrong for someone else's setup.
 */
export interface ModelOutputLimits {
  contextWindow: number
  defaultMaxTokens?: number
  testedOutputCap?: number
}

/** Public model metadata only; resolving limits does not start a model turn. */
export async function resolveModelOutputLimits(ctx: Context, provider: string, model: string): Promise<ModelOutputLimits> {
  const info = await ctx.llm.resolveModelInfo(provider, model)
  const contextWindow = info.context?.contextWindow
  if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) <= 0) throw new Error('The configured model does not disclose a usable context window')
  fittedOutputReservation(Number(contextWindow))
  return { contextWindow: Number(contextWindow), defaultMaxTokens: info.defaultMaxTokens }
}
