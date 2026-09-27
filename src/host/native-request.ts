import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Auxiliary native calls may carry a session without an active Agent turn. */
export function nativeRequestAgent(ctx: Context, request: GenerateOptions): Agent | undefined {
  const initiator = ctx.agents.currentInitiator()
  const sessionAgent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
  // A session-tagged title/summary can run beneath a different initiator. Its
  // explicit session identifies the billed work, as in the native call log.
  return sessionAgent ?? initiator
}
