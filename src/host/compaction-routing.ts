import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PhysicalRoute, Role } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SessionBinding } from './bindings.js'

/** Structural v1 optional contract exported by dsh-compact-saviour. */
interface RouteSnapshot {
  revision: string
  context: PhysicalRoute
  target: PhysicalRoute
  maxOutputTokens?: number
}
interface Registry {
  apiVersion: number
  register(owner: string, resolve: (agent: Agent) => RouteSnapshot | undefined): () => void
}
interface Owner { binding: SessionBinding; role: Role }

/** Publish exact session routes before another plugin estimates or chunks input. */
export function installCompactionRouting(ctx: Context, input: {
  owner(agent: Agent): Owner | undefined
  route(binding: SessionBinding, role: Role): PhysicalRoute
  epoch(binding: SessionBinding): number
}): () => void {
  let active = true
  const fiber = ctx.inject(['compactionRoutes'], child => {
    const registry = child.get('compactionRoutes') as Registry
    if (registry.apiVersion !== 1 || typeof registry.register !== 'function')
      throw new Error('Unsupported public compaction routing contract')
    child.effect(() => registry.register('dsh-model-fusion', agent => {
      if (!active) return undefined
      const owner = input.owner(agent)
      if (!owner) return undefined
      const { binding, role } = owner
      const context = input.route(binding, role)
      const target = binding.profile.compactor?.route ?? context
      const maxOutputTokens = binding.profile.compactor?.maxOutputTokens
      return { context: { ...context }, target: { ...target },
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        revision: digestOf({ session: agent.id, task: binding.taskId, profile: binding.profile.digest,
          role, epoch: input.epoch(binding), context, target, maxOutputTokens: maxOutputTokens ?? null }) }
    }))
  })
  return () => { active = false; void fiber.dispose() }
}
