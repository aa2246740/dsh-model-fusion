/**
 * Runtime detection for the DSH 0.2.2-rc.5 subagent seam.
 */

export const supportedDshVersions = '0.2.2-rc.5'

export function hasStartActivation(subagents: object): boolean {
  return typeof (subagents as { startActivation?: unknown }).startActivation === 'function'
}

export function requireSubagentMethod(subagents: object, method: string): string {
  const api = subagents as Record<string, unknown>
  if (typeof api[method] === 'function') return method
  throw new Error(`Fusion supports DeepSeek Harness ${supportedDshVersions}; this host does not provide subagents.${method}`)
}
