/**
 * Workspace write mutual exclusion for agents Fusion owns.
 * Ordinary sessions are not governed: a foreign lease does not make them read-only.
 * `exempt` covers read tools, Fusion's own control tools, and `run_code`.
 * The caller passes the lease for this call's cwd only, so another directory is isolated.
 */
export declare function workspaceWriterDenial(input: {
    fusionOwned: boolean;
    exempt: boolean;
    cwd?: string;
    leaseHolder?: string;
    agentId: string;
}): string | undefined;
