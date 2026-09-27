import type { AcceptanceCriterion, Digest, SnapshotId, ToolEvidence, VerificationLevel, WorkOrder, WorkerReport } from '../contracts.js';
import { type VerificationRegistry } from './receipts.js';
export interface EvidenceVerdict {
    readonly verification: VerificationLevel;
    readonly reasons: readonly string[];
}
export type TrustedEvidenceRegistry = readonly ToolEvidence[] | Readonly<Record<string, ToolEvidence>> | ReadonlyMap<string, ToolEvidence>;
export interface RegisteredVerifier {
    readonly id: string;
    readonly kind: AcceptanceCriterion['verificationKind'];
    readonly argvDigests?: readonly Digest[];
}
export interface EvaluateReportOptions {
    readonly verifiers?: readonly RegisteredVerifier[];
    readonly registry?: VerificationRegistry;
}
export declare const DEFAULT_TEST_VERIFIERS: readonly RegisteredVerifier[];
/**
 * Score only the current work order's mandatory criteria and the evidence those
 * claims actually cite. Historical failures stay in the registry for audit.
 * Authenticity and relevance are independent checks.
 */
export declare function evaluateReport(workOrder: WorkOrder, report: WorkerReport, trustedRegistry: TrustedEvidenceRegistry, currentSnapshot: SnapshotId, options?: EvaluateReportOptions): EvidenceVerdict;
