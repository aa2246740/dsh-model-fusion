import type { OutboxRow, SessionId } from '../contracts.js'
import { NEEDS_REPAIR, OUTCOME_UNKNOWN } from '../errors.js'

export type ChildPersistence = 'present' | 'missing' | 'corrupt'

export interface RecoveryScan {
  readonly outbox: OutboxRow
  readonly childPersistence: ChildPersistence
  readonly effectKnown: boolean | null
  readonly reportAlreadyRecorded: boolean
  readonly parentDelivered: boolean
}

export type RecoveryDecision =
  | { action: 'retry-prepare'; child: SessionId }
  | { action: 'resume-child'; child: SessionId }
  | { action: 'return-stored-result' }
  | { action: 'needs-repair'; code: typeof NEEDS_REPAIR }
  | { action: 'outcome-unknown'; code: typeof OUTCOME_UNKNOWN }
  | { action: 'idle' }

export function reconcile(scan: RecoveryScan): RecoveryDecision {
  if (scan.reportAlreadyRecorded && !scan.parentDelivered) return { action: 'return-stored-result' }
  if (scan.reportAlreadyRecorded && scan.parentDelivered) return { action: 'idle' }
  if (scan.effectKnown === null && (scan.outbox.state === 'dispatched' || scan.outbox.state === 'claimed')) {
    return { action: 'outcome-unknown', code: OUTCOME_UNKNOWN }
  }
  if (scan.outbox.state === 'prepared' && scan.childPersistence === 'missing' && scan.outbox.reservedChild) {
    return { action: 'retry-prepare', child: scan.outbox.reservedChild }
  }
  if (scan.outbox.state === 'accepted' && scan.childPersistence !== 'present') {
    return { action: 'needs-repair', code: NEEDS_REPAIR }
  }
  if ((scan.outbox.state === 'accepted' || scan.outbox.state === 'claimed') && scan.outbox.reservedChild) {
    return { action: 'resume-child', child: scan.outbox.reservedChild }
  }
  return { action: 'idle' }
}
