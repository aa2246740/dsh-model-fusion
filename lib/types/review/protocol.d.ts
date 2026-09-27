export type ReviewStatus = 'complete' | 'incomplete' | 'not_required' | 'failed';
export type ReviewDecision = 'approve' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE';
export type ExecutionPath = 'direct' | 'forced_fusion' | 'fusion_auto';
export type ReviewTermination = 'success' | 'truncated' | 'aborted' | 'error' | 'filtered' | 'unknown';
export interface ReviewClassification {
    reviewStatus: ReviewStatus;
    decision: ReviewDecision | 'not_required';
    protocolComplete: boolean;
    /** True only after a substitute artifact was actually delivered. */
    fallbackUsed: boolean;
    /** True when a fallback or retry is still required. */
    fallbackRequired: boolean;
    termination: ReviewTermination;
    reasons: readonly string[];
}
export interface ReviewAttemptFields {
    artifactPass: boolean;
    executionPath: ExecutionPath;
    leadReviewStatus: ReviewStatus;
    finishReason: string | null;
    protocolComplete: boolean;
    fallbackUsed: boolean;
    deliveredArtifactSource: string | null;
}
export declare function normalizeTermination(input: {
    finishReason?: string | null;
    termination?: ReviewTermination;
    completeEvidence?: boolean;
}): ReviewTermination;
/**
 * Lead review is fail-closed. Only an explicit success termination plus a
 * versioned accept/rework/needs-decision structure can complete the protocol.
 * DIRECT skips review.
 */
export declare function classifyReview(input: {
    executionPath: ExecutionPath;
    finishReason?: string | null;
    termination?: ReviewTermination;
    completeEvidence?: boolean;
    rawText?: string | null;
    parsed?: unknown;
}): ReviewClassification;
/** Map classifier output onto the reducer event decision. */
export declare function toReducerReviewDecision(classification: ReviewClassification): 'accept' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE';
export declare function reviewAttemptFields(input: {
    artifactPass: boolean;
    executionPath: ExecutionPath;
    classification: ReviewClassification;
    finishReason?: string | null;
    deliveredArtifactSource?: string | null;
}): ReviewAttemptFields;
