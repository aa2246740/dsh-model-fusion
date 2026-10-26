/** A model-facing tool, identified by the name the request will advertise. */
export interface NamedTool {
    name: string;
}
export interface ProjectedTools<T extends NamedTool> {
    tools: T[];
    /** Fusion tools this role must see that neither the assembled table nor the registry still has. */
    missing: string[];
}
/**
 * Rebuild one role's request tool table after another plugin replaces `assembled.tools`.
 *
 * The allowlist is a capability ceiling, not a list of mandatory registrations.
 * It filters the assembled table, then permitted names are copied back from this
 * agent's own registry: allowlisted tools (such as `job_output`) and Fusion's own
 * `fusion_*` registrations. An undefined allowlist keeps the assembled table and only
 * unions Fusion's registrations, so a writing role is not narrowed.
 *
 * A Fusion tool is required only when this agent actually registered it and the role
 * may see it. `fusion_read_state` and `fusion_delegate_text` are registered only for
 * model-like profiles; a legacy allowlist that merely names them is not incomplete.
 * Restore copies every permitted registry tool before the gap is measured, so `missing`
 * stays empty for every table this function itself builds. The field remains so a later
 * change that stops restoring a registered tool fails closed instead of sending a
 * silently smaller catalog.
 */
export declare function projectRoleTools<T extends NamedTool>(input: {
    assembled: readonly T[];
    allowlist: readonly string[] | undefined;
    registry: readonly T[];
    /** Names this role keeps even when the allowlist omits them. */
    always?: readonly string[];
}): ProjectedTools<T>;
/** Shown when the role's Fusion tools cannot be restored. The request must not proceed as a normal completion. */
export declare function fusionToolDiagnostic(missing: readonly string[]): string;
