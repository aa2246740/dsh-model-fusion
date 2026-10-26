/**
 * Workspace write mutual exclusion for agents Fusion owns.
 * Ordinary sessions are not governed: a foreign lease does not make them read-only.
 * `exempt` covers read tools, Fusion's own control tools, and `run_code`.
 * The caller passes the lease for this call's cwd only, so another directory is isolated.
 */
export function workspaceWriterDenial(input: {
  fusionOwned: boolean
  exempt: boolean
  cwd?: string
  leaseHolder?: string
  agentId: string
}): string | undefined {
  if (!input.fusionOwned || input.exempt) return undefined
  if (!input.cwd || !input.leaseHolder || input.leaseHolder === input.agentId) return undefined
  return `Workspace writer is ${input.leaseHolder}; this Agent is read-only`
}
