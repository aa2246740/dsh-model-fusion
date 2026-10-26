/**
 * Runtime detection for the DSH subagent seam.
 * 0.2.1-rc.2 renamed continuable start/drain and removed `ctx.subagents.start`.
 * 0.2.0-rc.2 still has the old names. Callers branch on the function that is
 * actually present. They do not read a version string.
 */
export declare const supportedDshVersions = "0.2.0-rc.2 and 0.2.1-rc.2";
export declare function hasStartActivation(subagents: object): boolean;
/** Prefer `primary` (the 0.2.1 name) when both exist. */
export declare function requireSubagentMethod(subagents: object, primary: string, fallback: string): string;
