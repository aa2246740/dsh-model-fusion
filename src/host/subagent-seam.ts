/**
 * Runtime detection for the DSH subagent seam.
 * 0.2.1-rc.2 renamed continuable start/drain and removed `ctx.subagents.start`.
 * 0.2.0-rc.2 still has the old names. Callers branch on the function that is
 * actually present. They do not read a version string.
 */

export const supportedDshVersions = '0.2.0-rc.2 and 0.2.1-rc.2'

export function hasStartActivation(subagents: object): boolean {
  return typeof (subagents as { startActivation?: unknown }).startActivation === 'function'
}

/** Prefer `primary` (the 0.2.1 name) when both exist. */
export function requireSubagentMethod(subagents: object, primary: string, fallback: string): string {
  const api = subagents as Record<string, unknown>
  if (typeof api[primary] === 'function') return primary
  if (typeof api[fallback] === 'function') return fallback
  throw new Error(`Fusion supports DeepSeek Harness ${supportedDshVersions}; this host has neither subagents.${primary} nor subagents.${fallback}`)
}
