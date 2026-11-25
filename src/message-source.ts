import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-model-fusion': { kind: 'plugin:dsh-model-fusion' } & ContextFormed
  }
}

/** Whether a native `user/message` source is a positive automatic Goal continuation round. */
export function isGoalInstructionSource(source: { readonly kind?: string; readonly round?: unknown } | undefined): boolean {
  return source?.kind === 'goal' && (source.round === undefined || typeof source.round === 'number' && source.round > 0)
}

/**
 * Whether a native `user/message` source carries authoritative task instructions:
 * direct human messages, legacy unspecified user-role messages, or positive
 * automatic Goal continuation rounds (`source.kind === 'goal'`, `round > 0`).
 * Never use this for human-only overrides (cancelling scheduled continuations,
 * clearing quota stops, or steering a blocking wait).
 */
export function isInstructionSource(source: { readonly kind?: string; readonly round?: unknown } | undefined): boolean {
  if (source === undefined || source.kind === 'user') return true
  return isGoalInstructionSource(source)
}
