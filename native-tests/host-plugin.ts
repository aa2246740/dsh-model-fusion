/** Cordis plugins may be default-exported classes or modules exposing `apply`. */
export function hostPlugin(mod: object): object {
  if (typeof mod === 'function') return mod
  const record = mod as { default?: unknown; apply?: unknown }
  if (typeof record.default === 'function') return record.default
  if (typeof record.apply === 'function') return mod
  throw new Error('Fusion supports DeepSeek Harness 0.2.2-rc.5; this host plugin is neither a default export nor an apply module')
}

/** Mount `@deepseek-ai/dsh-working-directory` (and local fs if needed) required by DSH 0.2.2 `SubagentRuntime`. */
export async function mountWorkingDirectory(ctx: { get(name: string): unknown; plugin(plugin: object, config?: object): Promise<unknown> }, cwd?: string): Promise<void> {
  const subagent = await import('@deepseek-ai/dsh-subagent')
  const service = hostPlugin(subagent) as { inject?: readonly string[] }
  if (!service.inject?.includes('workingDirectory')) return
  let directory: object
  try { directory = await import('@deepseek-ai/dsh-working-directory') }
  catch { return }
  if (ctx.get('workingDirectory') !== undefined) return
  if (ctx.get('fs') === undefined) {
    const fs = await import('@deepseek-ai/dsh-fs-local')
    await ctx.plugin(hostPlugin(fs), cwd ? { cwd } : {})
  }
  await ctx.plugin(hostPlugin(directory), cwd ? { defaultDirectory: cwd } : {})
}
