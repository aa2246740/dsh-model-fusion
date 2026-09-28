/**
 * The native shell tool the Host mounts on this platform. cordis.patch.yml
 * disables tool-bash on win32 and mounts tool-pwsh instead; elsewhere the
 * bash tool is the native shell. Safety gates must apply to whichever shell
 * tool issued the call, so checks use {@link isShellTool}, while defaults
 * and probes use {@link nativeShellTool} — the tool that actually exists.
 */
export const nativeShellTool: 'bash' | 'pwsh' = process.platform === 'win32' ? 'pwsh' : 'bash'

export const isShellTool = (name: string): name is 'bash' | 'pwsh' => name === 'bash' || name === 'pwsh'

/** Command text the prompt layer names for the platform's native shell. */
export const nativeShellDescription = process.platform === 'win32' ? 'pwsh' : 'bash'
