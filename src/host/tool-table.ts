/** A model-facing tool, identified by the name the request will advertise. */
export interface NamedTool { name: string }

export interface ProjectedTools<T extends NamedTool> {
  tools: T[]
  /** Fusion tools this role must see that neither the assembled table nor the registry still has. */
  missing: string[]
}

/**
 * Rebuild one role's request tool table after another plugin replaces `assembled.tools`.
 *
 * The allowlist is applied as a filter, then missing names are copied back from this
 * agent's own registry: allowlisted tools (such as `job_output`) and Fusion's own
 * `fusion_*` registrations. An undefined allowlist keeps the assembled table and only
 * unions Fusion's registrations, so a writing role is not narrowed.
 */
export function projectRoleTools<T extends NamedTool>(input: {
  assembled: readonly T[]
  allowlist: readonly string[] | undefined
  registry: readonly T[]
  /** Names this role keeps even when the allowlist omits them. */
  always?: readonly string[]
}): ProjectedTools<T> {
  const always = input.always ?? []
  const permitted = (name: string) => input.allowlist === undefined || input.allowlist.includes(name) || always.includes(name)
  const tools = input.allowlist === undefined ? [...input.assembled] : input.assembled.filter(tool => permitted(tool.name))
  const present = new Set(tools.map(tool => tool.name))
  const owned = input.registry.filter(tool => tool.name.startsWith('fusion_'))
  const restore = input.allowlist === undefined
    ? owned
    : input.registry.filter(tool => permitted(tool.name))
  for (const tool of restore) {
    if (present.has(tool.name)) continue
    tools.push(tool)
    present.add(tool.name)
  }
  const required = (input.allowlist === undefined ? owned.map(tool => tool.name) : [...input.allowlist, ...always])
    .filter(name => name.startsWith('fusion_'))
  return { tools, missing: [...new Set(required)].filter(name => !present.has(name)) }
}

/** Shown when the role's Fusion tools cannot be restored. The request must not proceed as a normal completion. */
export function fusionToolDiagnostic(missing: readonly string[]): string {
  return `FUSION_TOOL_TABLE_INCOMPLETE: required Fusion tools are absent from this request (${missing.join(', ')}). Another plugin replaced the tool table and Fusion could not restore them from its own registry. Do not tell the user that delegation is unavailable by design, and do not end the task as completed with no work. Report this diagnostic.`
}
