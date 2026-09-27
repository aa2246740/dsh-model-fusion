import type { FusionEvent, ReviewTicket } from '../src/contracts.js'
import type { ReviewClassification } from '../src/review/protocol.js'
import { resultFromCapturedTicket } from '../src/review/ticket.js'

// Synthetic accepting outcomes belong to deterministic tests only.
export function completeAcceptClassification(): ReviewClassification {
  return {
    reviewStatus: 'complete',
    decision: 'approve',
    protocolComplete: true,
    fallbackUsed: false,
    fallbackRequired: false,
    termination: 'success',
    reasons: [],
  }
}

export function acceptedResultFromTicket(
  ticket: Readonly<ReviewTicket>,
  seq: number,
  extras: { eventId?: string; createdAt?: string; terminalEvidenceRef: string } & Partial<{ classification: ReviewClassification }>,
): Extract<FusionEvent, { type: 'review/completed' }> {
  return resultFromCapturedTicket(
    ticket,
    {
      requestId: ticket.requestId,
      terminalEvidenceRef: extras.terminalEvidenceRef,
      classification: extras.classification ?? completeAcceptClassification(),
    },
    {
      eventId: extras.eventId ?? `review-completed-${ticket.requestId}`,
      seq,
      createdAt: extras.createdAt ?? '2026-09-21T00:00:00Z',
    },
  )
}
