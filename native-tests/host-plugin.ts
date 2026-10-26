/**
 * 0.2.0 Cordis plugins are default-exported classes. Some 0.2.1 plugins,
 * including JSONL session persistence, are modules with `apply` and no default.
 */
export function hostPlugin(mod: object): object {
  if (typeof mod === 'function') return mod
  const record = mod as { default?: unknown; apply?: unknown }
  if (typeof record.default === 'function') return record.default
  if (typeof record.apply === 'function') return mod
  throw new Error('Fusion supports DeepSeek Harness 0.2.0-rc.2 and 0.2.1-rc.2; this host plugin is neither a default export nor an apply module')
}

/** 0.2.1 SubagentRuntime injects `workingDirectory`. 0.2.0 does not, and must not load that service. */
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
