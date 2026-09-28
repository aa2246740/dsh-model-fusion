import type { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'

/** The native shell tool the Host mounts on this platform: pwsh on Windows, bash elsewhere. */
export const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'

/** The Python interpreter command on this platform (the VM ships `python`, not `python3`). */
export const python = process.platform === 'win32' ? 'python' : 'python3'

/**
 * Rewrites a POSIX command line's Python launcher for Windows: `python3` →
 * `python`, and `python -B -m unittest` → a `python -c` + runpy equivalent that
 * inserts the cwd on sys.path first — the embedded Python on the Windows VM
 * (python312._pth) otherwise never resolves workspace test modules. The
 * remaining unittest args (`-v test_calc`, `test_calc.TestAdd.test_add`, `&&`)
 * are preserved verbatim.
 */
export const py = (command: string) => process.platform === 'win32'
  ? command.replace(/^python3\b/, 'python').replace(/^python -B -m unittest\b/,
    `python -B -c "import sys; sys.path.insert(0, '.'); import runpy; runpy.run_module('unittest', run_name='__main__')"`)
  : command

/**
 * Mounts the platform's real native shell: subprocess runtime, shell env, executor,
 * optional job registry + job tools, then the shell tool itself.
 */
export async function mountNativeShell(ctx: Context, options: { dshHome: string, timeoutMs?: number, jobs?: boolean }): Promise<void> {
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv, { dshHome: options.dshHome })
  if (process.platform === 'win32') {
    await ctx.plugin(PwshLocalExecutor, { timeoutMs: options.timeoutMs ?? 5_000 })
    if (options.jobs) { await ctx.plugin(LocalJobs); await ctx.plugin(ToolJobs, {}) }
    await ctx.plugin(ToolPwsh, { enableRunInBackground: options.jobs ?? false })
  }
  else {
    await ctx.plugin(LocalBashExecutor, { timeoutMs: options.timeoutMs ?? 5_000 })
    if (options.jobs) { await ctx.plugin(LocalJobs); await ctx.plugin(ToolJobs, {}) }
    await ctx.plugin(ToolBash, { enableRunInBackground: options.jobs ?? false })
  }
}

/** A real POSIX command string, with its real pwsh equivalent on Windows. */
export const shellCommand = (posix: string, windows: string): string => process.platform === 'win32' ? windows : posix
