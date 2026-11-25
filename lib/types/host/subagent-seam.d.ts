/**
 * Runtime detection for the DSH 0.2.2-rc.5 subagent seam.
 */
export declare const supportedDshVersions = "0.2.2-rc.5";
export declare function hasStartActivation(subagents: object): boolean;
export declare function requireSubagentMethod(subagents: object, method: string): string;
