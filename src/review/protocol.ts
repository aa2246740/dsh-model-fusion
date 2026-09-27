export type ReviewStatus = 'complete' | 'incomplete' | 'not_required' | 'failed'

export type ReviewDecision = 'approve' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE'

export type ExecutionPath = 'direct' | 'forced_fusion' | 'fusion_auto'

export type ReviewTermination = 'success' | 'truncated' | 'aborted' | 'error' | 'filtered' | 'unknown'

export interface ReviewClassification {
  reviewStatus: ReviewStatus
  decision: ReviewDecision | 'not_required'
  protocolComplete: boolean
  /** True only after a substitute artifact was actually delivered. */
  fallbackUsed: boolean
  /** True when a fallback or retry is still required. */
  fallbackRequired: boolean
  termination: ReviewTermination
  reasons: readonly string[]
}

export interface ReviewAttemptFields {
  artifactPass: boolean
  executionPath: ExecutionPath
  leadReviewStatus: ReviewStatus
  finishReason: string | null
  protocolComplete: boolean
  fallbackUsed: boolean
  deliveredArtifactSource: string | null
}

const VALID_DECISIONS = new Set(['approve', 'accept', 'rework', 'needs-decision'])

const SUCCESS_REASONS = new Set(['stop', 'end_turn', 'end-turn', 'tool_calls', 'tool_call', 'completed', 'success'])
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'max_token'])
const ABORTED_REASONS = new Set(['aborted', 'abort', 'cancelled', 'canceled', 'cancel'])
const ERROR_REASONS = new Set(['error', 'internal_error', 'server_error'])
const FILTERED_REASONS = new Set(['content_filter', 'content-filter', 'filtered', 'contentfilter'])

function normalizeFinishReason(finishReason: string | null | undefined): string | null {
  if (finishReason === null || finishReason === undefined) return null
  const trimmed = finishReason.trim().toLowerCase()
  return trimmed.length ? trimmed : null
}

function terminationFromFinishReason(finishReason: string | null): ReviewTermination | null {
  if (finishReason === null) return null
  if (SUCCESS_REASONS.has(finishReason)) return 'success'
  if (TRUNCATED_REASONS.has(finishReason)) return 'truncated'
  if (ABORTED_REASONS.has(finishReason)) return 'aborted'
  if (ERROR_REASONS.has(finishReason)) return 'error'
  if (FILTERED_REASONS.has(finishReason)) return 'filtered'
  return 'unknown'
}

export function normalizeTermination(input: {
  finishReason?: string | null
  termination?: ReviewTermination
  completeEvidence?: boolean
}): ReviewTermination {
  const finishReason = normalizeFinishReason(input.finishReason)
  const fromFinish = terminationFromFinishReason(finishReason)
  if (input.termination && fromFinish && input.termination !== fromFinish) {
    return 'unknown'
  }
  if (input.termination) return input.termination
  if (fromFinish) return fromFinish
  return input.completeEvidence === true ? 'success' : 'unknown'
}

function parsedDecision(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const decision = (parsed as { decision?: unknown }).decision
  return typeof decision === 'string' ? decision.trim().toLowerCase() : undefined
}

function incomplete(
  reasons: readonly string[],
  termination: ReviewTermination,
  reviewStatus: ReviewStatus = 'incomplete',
): ReviewClassification {
  return {
    reviewStatus,
    decision: 'REVIEW_INCOMPLETE',
    protocolComplete: false,
    fallbackUsed: false,
    fallbackRequired: true,
    termination,
    reasons,
  }
}

/**
 * Lead review is fail-closed. Only an explicit success termination plus a
 * versioned accept/rework/needs-decision structure can complete the protocol.
 * DIRECT skips review.
 */
export function classifyReview(input: {
  executionPath: ExecutionPath
  finishReason?: string | null
  termination?: ReviewTermination
  completeEvidence?: boolean
  rawText?: string | null
  parsed?: unknown
}): ReviewClassification {
  if (input.executionPath === 'direct') {
    return {
      reviewStatus: 'not_required',
      decision: 'not_required',
      protocolComplete: true,
      fallbackUsed: false,
      fallbackRequired: false,
      termination: 'success',
      reasons: ['direct path does not require Lead review'],
    }
  }

  const reasons: string[] = []
  const termination = normalizeTermination(input)
  if (termination === 'truncated') reasons.push(`finish_reason=${normalizeFinishReason(input.finishReason) ?? 'truncated'}`)
  if (termination === 'aborted') reasons.push('termination=aborted')
  if (termination === 'error') reasons.push('termination=error')
  if (termination === 'filtered') reasons.push('termination=filtered')
  if (termination === 'unknown') reasons.push('termination=unknown; parsed text is not success evidence')

  const raw = input.rawText ?? ''
  if (!raw.trim()) reasons.push('empty review output')

  const decision = parsedDecision(input.parsed)
  if (input.parsed !== undefined && input.parsed !== null && !decision) {
    reasons.push('illegal review structure')
  } else if (decision && !VALID_DECISIONS.has(decision)) {
    reasons.push(`illegal review decision ${decision}`)
  }

  if (termination === 'truncated' || termination === 'unknown') {
    return incomplete(reasons.length ? reasons : [`termination=${termination}`], termination)
  }
  if (termination === 'aborted' || termination === 'error' || termination === 'filtered') {
    return incomplete(reasons, termination, 'failed')
  }

  if (reasons.length) {
    return incomplete(reasons, termination)
  }

  if (decision === 'rework') {
    return {
      reviewStatus: 'complete',
      decision: 'rework',
      protocolComplete: true,
      fallbackUsed: false,
      fallbackRequired: false,
      termination,
      reasons: [],
    }
  }
  if (decision === 'needs-decision') {
    return {
      reviewStatus: 'complete',
      decision: 'needs-decision',
      protocolComplete: true,
      fallbackUsed: false,
      fallbackRequired: false,
      termination,
      reasons: [],
    }
  }
  if (decision === 'approve' || decision === 'accept') {
    return {
      reviewStatus: 'complete',
      decision: 'approve',
      protocolComplete: true,
      fallbackUsed: false,
      fallbackRequired: false,
      termination,
      reasons: [],
    }
  }

  return incomplete(['review decision missing'], termination)
}

/** Map classifier output onto the reducer event decision. */
export function toReducerReviewDecision(
  classification: ReviewClassification,
): 'accept' | 'rework' | 'needs-decision' | 'REVIEW_INCOMPLETE' {
  if (classification.decision === 'approve') return 'accept'
  if (classification.decision === 'rework') return 'rework'
  if (classification.decision === 'needs-decision') return 'needs-decision'
  return 'REVIEW_INCOMPLETE'
}

export function reviewAttemptFields(input: {
  artifactPass: boolean
  executionPath: ExecutionPath
  classification: ReviewClassification
  finishReason?: string | null
  deliveredArtifactSource?: string | null
}): ReviewAttemptFields {
  const deliveredArtifactSource = input.deliveredArtifactSource ?? null
  return {
    artifactPass: input.artifactPass,
    executionPath: input.executionPath,
    leadReviewStatus: input.classification.reviewStatus,
    finishReason: input.finishReason ?? null,
    protocolComplete: input.classification.protocolComplete,
    fallbackUsed: Boolean(deliveredArtifactSource) && (
      input.classification.fallbackRequired || input.classification.fallbackUsed
    ),
    deliveredArtifactSource,
  }
}
