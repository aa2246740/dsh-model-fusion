import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ToolEvidence, WorkOrder, WorkerReport } from '../contracts.js';
import { evaluateReport } from '../evidence/gate.js';
import type { CheckPlan, PlannedReceipt } from '../evidence/receipts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
export interface CheckDefinition {
    id: string;
    description: string;
    command: string;
    kind: 'test' | 'static-check';
    parser: TestParser | 'exit-code';
    /** Existing acceptance test files. Their bytes may not change during execution. May be empty for a new project. */
    definitionPaths: readonly string[];
    /** Per-check limit; defaults to the work-order policy. */
    timeoutSeconds?: number;
    /**
     * `no-new-failures`: a broad regression suite measured against the untouched workspace. The Host runs it
     * once before the Worker starts and freezes the failing test ids; the candidate passes when every failure
     * it shows was already failing there. Default: every test must pass.
     */
    baseline?: 'no-new-failures';
}
/** Parsers that name each failing test, which baseline-relative checks need. */
export declare const BASELINE_PARSERS: readonly ["pytest"];
export declare const TEST_PARSERS: readonly ["unittest", "pytest", "vitest", "jest", "mocha", "tap", "go", "cargo"];
export type TestParser = typeof TEST_PARSERS[number];
export declare const MAX_CHECK_SECONDS = 3600;
export interface FrozenCheck {
    definition: CheckDefinition;
    plan: CheckPlan;
}
/** Shell setup failures need a corrected check, rather than an implementation repair. */
export declare function checkCommandUnavailable(exitCode: number | null, stderr: string, platform?: NodeJS.Platform): boolean;
export declare function freezeChecks(order: WorkOrder, root: string, definitions: readonly CheckDefinition[]): FrozenCheck[];
/**
 * Counts passed tests from a runner's summary. A suite passes when nothing failed or errored and at
 * least one test ran; skipped, deselected, pending, ignored and expected-failure tests were not
 * executed and do not veto the result (real projects routinely skip optional-dependency tests; study
 * 2026-09-26: "799 passed, 86 skipped" blocked an otherwise verified acceptance).
 */
export declare function parseTestCounts(parser: CheckDefinition['parser'], text: string): PlannedReceipt['counts'];
/**
 * Passed count and the ids of failing tests, only when the output names every failure the summary counts.
 * pytest prints `FAILED <id>` / `ERROR <id>` in its short summary by default (`-r fE`).
 */
export declare function parseTestFailures(parser: CheckDefinition['parser'], text: string): {
    passed: number;
    failedIds: string[];
} | undefined;
/**
 * Bare program names each simple command segment starts with. Paths are left
 * out because an earlier `cd` in the same command changes where they resolve;
 * anything this cannot parse is simply not probed.
 */
export declare function checkPrograms(command: string, platform?: NodeJS.Platform): string[];
/**
 * Resolves program names the way the native bash tool will: `bash -c` with the
 * Host's own PATH (its subprocess scrub removes only credential-shaped and
 * DSH_* names). Running here instead of through the tool keeps this read-only
 * probe out of the user's approval flow. Returns undefined when inconclusive,
 * for example without bash; the recorded check result is then the fallback.
 */
export declare function probeMissingPrograms(root: string, programs: readonly string[]): Promise<{
    missing: string[];
    alternatives: Record<string, string[]>;
    locations: Record<string, string[]>;
} | undefined>;
/**
 * Where a program missing from the Host PATH is installed anyway. A desktop app started from the Dock gets only
 * the system PATH, so Homebrew, version-manager and per-user tools are invisible to bash there; naming the
 * absolute path lets the Lead retry once instead of searching.
 */
export declare function programLocations(name: string, home?: string): string[];
/** Trusted producer: commands run through native dispatch/permission and retain the enclosing tool token. */
interface CheckInput {
    ctx: Context;
    store: SqliteFusionStore;
    exec: ToolRunContext;
    root: string;
    order: WorkOrder;
    nativeTimeout?: boolean;
    authorizeNested(callId: string): () => void;
    uncertain?(evidence: ToolEvidence): void;
}
/**
 * Runs every baseline-relative check on the untouched workspace before the Worker starts and freezes the
 * failing test ids into its plan. An unreadable baseline refuses the delegation: guessing would let a
 * candidate hide new failures.
 */
export declare function runBaselineChecks(input: CheckInput & {
    checks: readonly FrozenCheck[];
}): Promise<FrozenCheck[]>;
export declare function runNativeChecks(input: CheckInput & {
    report: WorkerReport;
    checks: readonly FrozenCheck[];
}): Promise<{
    report: WorkerReport;
    receipts: PlannedReceipt[];
    verdict: ReturnType<typeof evaluateReport>;
}>;
export {};
