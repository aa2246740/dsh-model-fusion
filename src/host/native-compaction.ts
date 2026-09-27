import { isAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { PairProfile, PhysicalRoute } from '../contracts.js'

/**
 * Public llm/stream routing for the Host's mutable, one-shot summary envelope.
 * The Host still owns the compaction transaction and records this exact target.
 * Never replace a prepared AgentLoop request or start a nested model call.
 */
export function routeNativeCompaction(request: GenerateOptions, profile: PairProfile, effectiveRoute?: PhysicalRoute): void {
  const choice = profile.compactor ?? (effectiveRoute && profile.interactionMode === 'model-like' ? { route: effectiveRoute, maxOutputTokens: request.maxTokens } : undefined)
  if (request.purpose !== 'compaction' || !choice) return
  if (isAgentLoopRequest(request) || Object.isFrozen(request)) {
    throw new Error('DSH 压缩请求已冻结，无法通过公开接口选择压缩模型')
  }
  request.provider = choice.route.provider
  request.model = choice.route.model
  if (choice.maxOutputTokens !== undefined) request.maxTokens = choice.maxOutputTokens
  if (choice.route.reasoningEffort === undefined) delete request.reasoningEffort
  else request.reasoningEffort = ReasoningEffortId(choice.route.reasoningEffort)
  // Pin the admitted target/cap through later middleware. Public llm.stream
  // accepts frozen envelopes and resolves adapter defaults on its own copy.
  Object.freeze(request)
}
