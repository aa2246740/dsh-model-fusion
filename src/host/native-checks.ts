import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { accessSync, constants, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ArtifactId, OperationId, SessionId } from '../contracts.js'
import type { ToolEvidence, WorkOrder, WorkerReport } from '../contracts.js'
import { digestOf, sha256Hex } from '../digest.js'
import { evaluateReport } from '../evidence/gate.js'
import type { CheckPlan, PlannedReceipt } from '../evidence/receipts.js'
import { assertPlannedCheck, memoryVerificationRegistry } from '../evidence/receipts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { snapshotWorkspace, workspacePath } from './workspace.js'
import { nativeShellTool } from './shell.js'

export interface CheckDefinition {
  id: string
  description: string
  command: string
  kind: 'test' | 'static-check'
  parser: TestParser | 'exit-code'
  /** Existing acceptance test files. Their bytes may not change during execution. May be empty for a new project. */
  definitionPaths: readonly string[]
  /** Per-check limit; defaults to the work-order policy. */
  timeoutSeconds?: number
  /**
   * `no-new-failures`: a broad regression suite measured against the untouched workspace. The Host runs it
   * once before the Worker starts and freezes the failing test ids; the candidate passes when every failure
   * it shows was already failing there. Default: every test must pass.
   */
  baseline?: 'no-new-failures'
}
/** Parsers that name each failing test, which baseline-relative checks need. */
export const BASELINE_PARSERS = ['pytest'] as const
export const TEST_PARSERS = ['unittest', 'pytest', 'vitest', 'jest', 'mocha', 'tap', 'go', 'cargo'] as const
export type TestParser = typeof TEST_PARSERS[number]
export const MAX_CHECK_SECONDS = 3_600
export interface FrozenCheck { definition: CheckDefinition; plan: CheckPlan }

/** Shell setup failures need a corrected check, rather than an implementation repair. */
export function checkCommandUnavailable(exitCode: number | null, stderr: string, platform: NodeJS.Platform = process.platform): boolean {
  if (exitCode === null || exitCode === 0) return false
  if (exitCode === 126 || exitCode === 127) return true
  if (platform !== 'win32') return false
  // PowerShell normally returns 1 for CommandNotFoundException. Its concise
  // error view omits the exception id, so also recognize its specific message.
  // A generic exit 1 or a missing data file must remain a normal check failure.
  const text = stderr.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ')
  return /\bCommandNotFoundException\b/.test(text)
    || /\bThe term ['"][^'"]+['"] is not recognized as (?:the |a )?name of a cmdlet, function, script file, or (?:executable|operable) program\b/i.test(text)
}

function definitionDigest(root: string, definition: CheckDefinition) {
  return digestOf({ definition, files: definition.definitionPaths.map(path => ({ path, digest: sha256Hex(readFileSync(workspacePath(root, path))) })) })
}

export function freezeChecks(order: WorkOrder, root: string, definitions: readonly CheckDefinition[]): FrozenCheck[] {
  // Zero checks is a review-only order: honest, and cheaper than forcing the Lead to do untestable work itself.
  if (definitions.length > 12) throw new Error('Delegate accepts at most 12 acceptance checks')
  const ids = new Set<string>()
  return definitions.map(definition => {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(definition.id) || ids.has(definition.id)) throw new Error('Acceptance check ids must be unique')
    ids.add(definition.id)
    if (!definition.description.trim() || !definition.command.trim() || definition.command.length > 8000) throw new Error('Invalid acceptance command')
    if (definition.kind === 'test' && !(TEST_PARSERS as readonly string[]).includes(definition.parser)) {
      throw new Error(`Test checks need a count parser (${TEST_PARSERS.join(', ')}); a runner without one is a static-check with the exit-code parser`)
    }
    if (definition.timeoutSeconds !== undefined && (!Number.isSafeInteger(definition.timeoutSeconds)
      || definition.timeoutSeconds < 1 || definition.timeoutSeconds > MAX_CHECK_SECONDS)) throw new Error(`timeoutSeconds must be 1–${MAX_CHECK_SECONDS}`)
    if (definition.kind === 'static-check' && definition.parser !== 'exit-code') throw new Error('Static checks use the exit-code parser')
    if (definition.baseline !== undefined && (definition.baseline !== 'no-new-failures' || definition.kind !== 'test'
      || !(BASELINE_PARSERS as readonly string[]).includes(definition.parser))) {
      throw new Error(`Acceptance check ${definition.id}: baseline "no-new-failures" needs a test check with a parser that names failing tests (${BASELINE_PARSERS.join(', ')})`)
    }
    for (const path of definition.definitionPaths) {
      if (!lstatSync(workspacePath(root, path), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Acceptance check ${definition.id}: definitionPaths must name existing regular files whose bytes stay unchanged; ${JSON.stringify(path)} is not one. Keep existing acceptance files here; new regression tests belong in allowedPaths and can still run through the acceptance command. Retry fusion_delegate with corrected definitionPaths; do not create placeholders or finish the task to release a lease.`)
      }
    }
    return { definition: structuredClone(definition), plan: {
      id: `check:${order.id}:${definition.id}`, version: 2, taskId: order.taskId,
      workOrderId: order.id, revision: order.revision, criterionId: definition.id, kind: definition.kind,
      snapshot: order.baseSnapshot, snapshotBinding: 'candidate', cwdDigest: digestOf(root), argvDigest: digestOf(definition.command),
      definitionDigest: definitionDigest(root, definition), policyDigest: digestOf(order.policy),
      ...(definition.kind === 'test' ? { minExecutedTests: 1 } : {}),
    } }
  })
}

/**
 * Counts passed tests from a runner's summary. A suite passes when nothing failed or errored and at
 * least one test ran; skipped, deselected, pending, ignored and expected-failure tests were not
 * executed and do not veto the result (real projects routinely skip optional-dependency tests; study
 * 2026-09-26: "799 passed, 86 skipped" blocked an otherwise verified acceptance).
 */
export function parseTestCounts(parser: CheckDefinition['parser'], text: string): PlannedReceipt['counts'] {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  let count: number | undefined
  if (parser === 'unittest') {
    // "OK", "OK (skipped=3)", "OK (skipped=1, expected failures=2)"; unexpected successes fail the run.
    const ok = [...clean.matchAll(/(?:^|\n)OK(?: \(([^)\n]*)\))?\s*(?:\n|$)/g)].at(-1)
    if (ok && !/unexpected successes=/.test(ok[1] ?? '')) count = Number([...clean.matchAll(/Ran (\d+) tests? in /g)].at(-1)?.[1])
      - Number(ok[1]?.match(/skipped=(\d+)/)?.[1] ?? 0) || undefined
  } else if (parser === 'pytest') {
    // The final summary line, e.g. "== 799 passed, 86 skipped, 3 warnings in 12.3s ==".
    const summary = [...clean.matchAll(/(?:^|\n)[=\s]*((?:\d+ \w+(?:, )?)+) in [\d.]+s/g)].at(-1)?.[1] ?? ''
    if (!/\b\d+ (?:failed|errors?)\b/.test(summary)) count = Number(summary.match(/\b(\d+) passed\b/)?.[1])
  } else if (parser === 'vitest') {
    // "Tests  12 passed (12)" or "Tests  12 passed | 2 skipped (14)"; any failure word disqualifies.
    const last = [...clean.matchAll(/(?:^|\n)\s*Tests\s+([^\n]*?)\s*\((\d+)\)/g)].at(-1)
    if (last && !/\bfailed\b/.test(last[1]!)) count = Number(last[1]!.match(/(\d+) passed/)?.[1])
  } else if (parser === 'jest') {
    // "Tests:       12 passed, 12 total" or "Tests: 2 skipped, 1 todo, 12 passed, 15 total".
    const last = [...clean.matchAll(/(?:^|\n)\s*Tests:\s+([^\n]*)/g)].at(-1)?.[1]
    if (last && !/\bfailed\b/.test(last)) count = Number(last.match(/(\d+) passed/)?.[1])
  } else if (parser === 'mocha' && !/\b\d+ failing\b/.test(clean)) {
    count = Number([...clean.matchAll(/(?:^|\n)\s*(\d+) passing\b/g)].at(-1)?.[1])
  } else if (parser === 'go' && !/(?:^|\n)\s*--- FAIL:|(?:^|\n)FAIL\b/.test(clean)) {
    // Needs `go test -v`: only verbose output names each passed test.
    const passed = [...clean.matchAll(/(?:^|\n)\s*--- PASS: /g)].length
    if (passed) count = passed
  } else if (parser === 'cargo') {
    const results = [...clean.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed;/g)]
    if (results.length && results.every(match => match[1] === 'ok' && match[3] === '0')) {
      count = results.reduce((sum, match) => sum + Number(match[2]), 0)
    }
  } else if (parser === 'tap' && !/(?:^|\n)not ok\b(?![^\n]*#\s*SKIP)/i.test(clean)) {
    // "ok 3 # SKIP reason" is a skip, not a pass; "not ok ... # TODO" is still a failure here.
    const plan = [...clean.matchAll(/(?:^|\n)1\.\.(\d+)\s*(?:\n|$)/g)].at(-1)
    const ok = [...clean.matchAll(/(?:^|\n)ok\s+\d+\b(?![^\n]*#\s*SKIP)/gi)].length
    const skipped = [...clean.matchAll(/(?:^|\n)(?:not )?ok\s+\d+\b[^\n]*#\s*SKIP/gi)].length
    if (plan && Number(plan[1]) === ok + skipped) count = ok
  }
  return count && Number.isSafeInteger(count) && count > 0 ? { executed: count, passed: count, failed: 0 } : undefined
}

/**
 * Passed count and the ids of failing tests, only when the output names every failure the summary counts.
 * pytest prints `FAILED <id>` / `ERROR <id>` in its short summary by default (`-r fE`).
 */
export function parseTestFailures(parser: CheckDefinition['parser'], text: string): { passed: number; failedIds: string[] } | undefined {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (parser !== 'pytest') return undefined
  const summary = [...clean.matchAll(/(?:^|\n)[=\s]*((?:\d+ \w+(?:, )?)+) in [\d.]+s/g)].at(-1)?.[1]
  if (!summary) return undefined
  const count = (word: RegExp) => Number(summary.match(word)?.[1] ?? 0)
  const failed = count(/\b(\d+) failed\b/) + count(/\b(\d+) errors?\b/)
  const ids = [...new Set([...clean.matchAll(/(?:^|\n)(?:FAILED|ERROR) (\S+)/g)].map(match => match[1]!))].sort()
  if (ids.length !== failed) return undefined
  return { passed: count(/\b(\d+) passed\b/), failedIds: ids }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const execFileAsync = promisify(execFile)
const WRAPPERS = new Set(['env', 'exec', 'time', 'nohup', 'command', 'nice'])
const WRAPPER_VALUE_OPTIONS: Record<string, string[]> = { env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  nice: ['-n', '--adjustment'], time: ['-f', '--format', '-o', '--output'] }
// PowerShell language statements are not programs: Get-Command cannot resolve
// them, even though the shell can execute the statement (for example exit 127).
const PWSH_KEYWORDS = new Set(['exit', 'return', 'throw', 'break', 'continue', 'if', 'else', 'elseif', 'switch',
  'for', 'foreach', 'while', 'do', 'until', 'try', 'catch', 'finally', 'trap', 'function', 'filter',
  'param', 'begin', 'process', 'end', 'dynamicparam', 'class', 'enum', 'data', 'using'])

/**
 * Bare program names each simple command segment starts with. Paths are left
 * out because an earlier `cd` in the same command changes where they resolve;
 * anything this cannot parse is simply not probed.
 */
export function checkPrograms(command: string, platform: NodeJS.Platform = process.platform): string[] {
  const programs = new Set<string>()
  // Quoted text is an argument (for example `python3 -c "...; sys.exit(1)"`), never a command boundary.
  // Heredoc bodies are data (hash lists, scripts fed to stdin), not commands.
  const noHeredocs = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' QUOTED ')
  const unquoted = noHeredocs.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' QUOTED ')
  // A command that sets its own PATH resolves programs somewhere this probe cannot see; its recorded result decides.
  if (/(^|[\s;&|(])(export\s+)?PATH=/.test(unquoted)) return []
  for (const segment of unquoted.split(/&&|\|\||[;|\n&()]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0, wrapper: string | undefined
    while (index < words.length) {
      const word = words[index]!
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index++
      else if (WRAPPERS.has(word)) { wrapper = word; index++ }
      else if (wrapper && word.startsWith('-')) {
        // A wrapper option that takes a separate value (`env -u NAME`, `nice -n 5`) consumes the next word too.
        index += WRAPPER_VALUE_OPTIONS[wrapper]?.includes(word) ? 2 : 1
      } else break
    }
    const word = words[index]
    // A program name has a letter and is not a long hex digest or a bare number.
    if (word && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(word) && /[A-Za-z]/.test(word) && !/^[0-9a-f]{16,}$/i.test(word)
      && !(platform === 'win32' && PWSH_KEYWORDS.has(word.toLowerCase()))) programs.add(word)
  }
  return [...programs]
}

/**
 * Resolves program names the way the native bash tool will: `bash -c` with the
 * Host's own PATH (its subprocess scrub removes only credential-shaped and
 * DSH_* names). Running here instead of through the tool keeps this read-only
 * probe out of the user's approval flow. Returns undefined when inconclusive,
 * for example without bash; the recorded check result is then the fallback.
 */
export async function probeMissingPrograms(root: string, programs: readonly string[]): Promise<{ missing: string[]; alternatives: Record<string, string[]>; locations: Record<string, string[]> } | undefined> {
  const variants = (name: string) => [`${name}3`, ...(name === 'python' || name === 'python3' ? ['py'] : [])].filter(item => item !== name)
  const names = [...new Set(programs.flatMap(name => [name, ...variants(name)]))]
  const script = process.platform === 'win32'
    ? `foreach ($p in @(${names.map(name => `'${name}'`).join(',')})) { if (Get-Command $p -ErrorAction SilentlyContinue) { Write-Output "FOUND $p" } }; Write-Output 'PROBE-DONE'`
    : `for p in ${names.map(name => `'${name}'`).join(' ')}; do command -v -- "$p" >/dev/null 2>&1 && printf 'FOUND %s\\n' "$p"; done; printf 'PROBE-DONE\\n'`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && !key.toUpperCase().startsWith('DSH_'))) as Record<string, string>
  const [shell, args] = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', script]] : ['bash', ['-c', script]]
  let text: string
  try { text = (await execFileAsync(shell, args, { cwd: root, env, timeout: process.platform === 'win32' ? 15_000 : 5_000 })).stdout }
  catch { return undefined }
  if (!text.includes('PROBE-DONE')) return undefined
  const found = new Set([...text.matchAll(/^FOUND (\S+)$/gm)].map(match => match[1]!))
  const missing = programs.filter(name => !found.has(name))
  return { missing, alternatives: Object.fromEntries(missing.map(name => [name, variants(name).filter(item => found.has(item))])),
    locations: Object.fromEntries(missing.map(name => [name, programLocations(name)])) }
}

/**
 * Where a program missing from the Host PATH is installed anyway. A desktop app started from the Dock gets only
 * the system PATH, so Homebrew, version-manager and per-user tools are invisible to bash there; naming the
 * absolute path lets the Lead retry once instead of searching.
 */
export function programLocations(name: string, home = homedir()): string[] {
  const windows = process.platform === 'win32'
  const dirs = windows
    ? [join(home, '.bun/bin'), join(home, '.deno/bin'), join(home, '.cargo/bin'),
      join(home, 'scoop/shims'), join(home, 'AppData/Roaming/npm'), join(home, 'AppData/Local/Programs'),
      join(home, 'AppData/Local/Microsoft/WinGet/Links')]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.cargo/bin'), join(home, '.bun/bin'),
      join(home, '.deno/bin'), join(home, '.volta/bin'), join(home, '.local/share/mise/shims'), join(home, '.asdf/shims')]
  try {
    const nvm = join(home, '.nvm/versions/node')
    dirs.push(...readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => join(nvm, version, 'bin')))
  } catch { /* no nvm */ }
  // Windows resolves executables through PATHEXT — an extensionless file is not runnable; POSIX checks the exec bit.
  const candidates = windows
    ? (name.includes('.') ? [name] : [])
      .concat((process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map(ext => `${name}${ext.toLowerCase()}`))
    : [name]
  return dirs.flatMap(dir => candidates.map(file => join(dir, file))).filter(path => {
    try { accessSync(path, windows ? constants.F_OK : constants.X_OK); return true } catch { return false }
  }).slice(0, 3)
}

/** Trusted producer: commands run through native dispatch/permission and retain the enclosing tool token. */
interface CheckInput {
  ctx: Context; store: SqliteFusionStore; exec: ToolRunContext; root: string; order: WorkOrder;
  nativeTimeout?: boolean; authorizeNested(callId: string): () => void; uncertain?(evidence: ToolEvidence): void
}

/** One frozen command through the native bash tool, recorded as invocation evidence. */
async function invokeCheck(input: CheckInput, check: FrozenCheck) {
  const { ctx, store, exec, root, order } = input
  if (definitionDigest(root, check.definition) !== check.plan.definitionDigest) throw new Error(`Frozen acceptance definition changed: ${check.definition.id}`)
  const before = snapshotWorkspace(root)
  const startedAt = new Date().toISOString()
  const callId = ToolCallId(`fusion-check-${randomUUID()}`)
  const operationId = OperationId(callId)
  const empty = store.putArtifact(order.taskId, Buffer.from(''), 'text/plain')
  const started: ToolEvidence = { schemaVersion: 1, taskId: order.taskId, operationId,
    actor: SessionId(exec.agent!.id), nativeToolCallId: callId,
    argvDigest: check.plan.argvDigest, cwdDigest: check.plan.cwdDigest,
    inputSnapshot: before.id, exitCode: null, startedAt, endedAt: null, stdout: empty, stderr: empty, state: 'started' }
  const key = `check-invocation:${order.taskId}:${callId}`
  store.writeDocument(key, 0, { check, evidence: started })
  const remove = input.authorizeNested(callId)
  let result
  try {
    result = await ctx.tools.execute({ callId, rootCallId: exec.rootCallId, parent: exec.token,
      name: nativeShellTool, arguments: { command: check.definition.command, description: check.definition.description,
        workdir: root, ...(input.nativeTimeout && check.definition.timeoutSeconds === undefined ? {} : { timeoutMs: (check.definition.timeoutSeconds ?? order.policy.commandMaxSeconds) * 1000 }), run_in_background: false },
      agent: exec.agent, signal: exec.signal })
  } catch (error) {
    const evidence: ToolEvidence = { ...started, state: 'outcome-unknown', endedAt: new Date().toISOString(),
      stderr: store.putArtifact(order.taskId, Buffer.from(String(error)), 'text/plain') }
    store.writeDocument(key, 1, { check, evidence })
    input.uncertain?.(evidence)
    throw error
  } finally { remove() }
  for (const context of result.additionalContexts ?? []) exec.deferContext(context)
  const raw = record(result.value)
  const stdout = record(raw?.stdout), stderr = record(raw?.stderr)
  const nativeForeground = !result.isError && raw?.kind === 'foreground'
  const completed = nativeForeground && raw.aborted === false && raw.timedOut === false
    && raw.signal === null && typeof raw.exitCode === 'number'
  const outText = typeof stdout?.text === 'string' ? stdout.text : ''
  const errText = typeof stderr?.text === 'string' ? stderr.text : JSON.stringify(result.content)
  const after = snapshotWorkspace(root)
  const evidence: ToolEvidence = { ...started, outputSnapshot: after.id,
    exitCode: completed ? Number(raw.exitCode) : null, endedAt: new Date().toISOString(),
    stdout: store.putArtifact(order.taskId, Buffer.from(outText), 'text/plain'),
    stderr: store.putArtifact(order.taskId, Buffer.from(errText), 'text/plain'),
    state: completed ? 'completed' : exec.signal.aborted ? 'cancelled' : 'outcome-unknown' }
  return { key, evidence, text: `${outText}\n${errText}`, truncated: Boolean(stdout?.truncated || stderr?.truncated), before, after }
}

/** Counts for a receipt; a baseline-relative check discounts failures frozen from the untouched workspace. */
function receiptCounts(check: FrozenCheck, text: string): PlannedReceipt['counts'] {
  const allowed = check.plan.allowedFailures
  if (!allowed) return parseTestCounts(check.definition.parser, text)
  const parsed = parseTestFailures(check.definition.parser, text)
  if (!parsed) return undefined
  const known = parsed.failedIds.filter(id => allowed.includes(id))
  const fresh = parsed.failedIds.filter(id => !allowed.includes(id))
  return { executed: parsed.passed + fresh.length, passed: parsed.passed, failed: fresh.length,
    ...(known.length ? { knownFailures: known } : {}), ...(fresh.length ? { newFailures: fresh } : {}) }
}

/**
 * Runs every baseline-relative check on the untouched workspace before the Worker starts and freezes the
 * failing test ids into its plan. An unreadable baseline refuses the delegation: guessing would let a
 * candidate hide new failures.
 */
export async function runBaselineChecks(input: CheckInput & { checks: readonly FrozenCheck[] }): Promise<FrozenCheck[]> {
  const out: FrozenCheck[] = []
  for (const check of input.checks) {
    if (check.definition.baseline !== 'no-new-failures') { out.push(check); continue }
    input.exec.signal.throwIfAborted()
    const run = await invokeCheck(input, check)
    input.store.writeDocument(run.key, 1, { check, evidence: run.evidence, baseline: true })
    if (run.evidence.state === 'outcome-unknown') {
      input.uncertain?.(run.evidence)
      throw new Error('Baseline command outcome is unknown; inspect the recorded effects before delegating')
    }
    if (run.before.id !== run.after.id) throw new Error(`Baseline run of ${check.definition.id} changed the source snapshot; use a command that does not write source files`)
    const parsed = run.evidence.state === 'completed' && !run.truncated ? parseTestFailures(check.definition.parser, run.text) : undefined
    if (!parsed) {
      throw new Error(`Baseline run of ${check.definition.id} could not be read (exit ${run.evidence.exitCode}, state ${run.evidence.state}). `
        + 'It needs a completed pytest run whose summary counts match the listed FAILED/ERROR ids. Retry fusion_delegate with a runnable command, or drop baseline to require every test to pass. '
        + `Output tail: ${run.text.slice(-600)}`)
    }
    out.push({ definition: check.definition, plan: { ...check.plan, allowedFailures: parsed.failedIds } })
  }
  return out
}

export async function runNativeChecks(input: CheckInput & {
  report: WorkerReport; checks: readonly FrozenCheck[];
}): Promise<{ report: WorkerReport; receipts: PlannedReceipt[]; verdict: ReturnType<typeof evaluateReport> }> {
  const { store, exec, root, order, checks } = input
  if (order.mode === 'text' && checks.length) throw new Error('Text assignments cannot run workspace checks')
  const receipts: PlannedReceipt[] = []
  for (const check of checks) {
    exec.signal.throwIfAborted()
    const run = await invokeCheck(input, check)
    const counts = run.truncated ? undefined : receiptCounts(check, run.text)
    const receipt: PlannedReceipt = { id: `receipt:${run.evidence.nativeToolCallId}`, planDigest: digestOf(check.plan), evidence: run.evidence, ...(counts ? { counts } : {}) }
    store.writeDocument(run.key, 1, { check, evidence: run.evidence, receipt })
    if (run.evidence.state === 'outcome-unknown') {
      input.uncertain?.(run.evidence)
      throw new Error('Acceptance command outcome is unknown; inspect the recorded effects before continuing')
    }
    receipts.push(receipt)
    if (run.before.id !== run.after.id) throw new Error('Acceptance command changed the source snapshot; rework is required')
  }
  const report: WorkerReport = { ...input.report,
    verification: receipts.flatMap(receipt => [receipt.evidence.stdout, receipt.evidence.stderr]),
    coverage: checks.map((check, index) => {
      const receipt = receipts[index]!
      let state: 'satisfied' | 'not-satisfied' | 'not-verified' = 'satisfied'
      let explanation = 'The frozen acceptance check passed on this exact candidate.'
      try { assertPlannedCheck(order, check.definition.id, check.plan, receipt, input.report.snapshot) }
      catch (error) {
        state = receipt.evidence.state === 'completed' && receipt.evidence.exitCode !== 0 ? 'not-satisfied' : 'not-verified'
        explanation = `Native check does not prove this criterion: ${String(error)}`
      }
      return { criterionId: check.definition.id, state, evidenceIds: [ArtifactId(receipt.id)], explanation }
    }) }
  const registry = memoryVerificationRegistry(checks.map(check => check.plan), receipts)
  if (order.mode === 'text' && checks.length) throw new Error('Text work cannot run filesystem checks')
  const verdict = evaluateReport(order, report, [], order.mode === 'text' ? report.snapshot : snapshotWorkspace(root).id, { registry })
  return { report, receipts, verdict }
}
