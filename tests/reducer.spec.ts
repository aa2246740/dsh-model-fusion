import { acceptedResultFromTicket } from './review-fixture.js'
import { describe, expect, it } from 'vitest'
import { ArtifactId } from '../src/contracts.js'
import { FusionError, REVISION_STALE } from '../src/errors.js'
import { reviewRequestedEvent } from '../src/review/ticket.js'
import { reduce, reduceAll } from '../src/task/reducer.js'
import { CHILD, SNAP, created, envelope, order } from './helpers.js'

const report = {
  schemaVersion: 1 as const,
  workOrderId: order().id,
  revision: 1,
  status: 'completed' as const,
  summary: 'done',
  snapshot: SNAP,
  changeManifest: {
    id: ArtifactId('m'),
    digest: digestish(),
    ownerTaskId: created().taskId,
    mediaType: 'text/plain',
    bytes: 1,
  },
  coverage: [],
  verification: [],
  unresolved: [],
  questions: [],
}

function digestish() {
  return 'a'.repeat(64) as ReturnType<typeof import('../src/digest.js').sha256Hex>
}

function happyPath() {
  const prefix = [
    created(),
    envelope('profile/frozen', 2, { digest: digestish(), profileId: 'fusion-auto', version: '0.1.0-experimental' }),
    envelope('intent/chosen', 3, { intent: 'DELEGATE' }),
    envelope('work-order/prepared', 4, { order: order(), reservedChild: CHILD }),
    envelope('child/accepted', 5, { operationId: order().operationId, child: CHILD, messageId: 'm1' }),
    envelope('report/submitted', 6, { operationId: order().operationId, report }),
    envelope('report/validated', 7, { operationId: order().operationId, report }),
  ]
  const requested = reviewRequestedEvent(reduceAll(prefix), 8, { ticketId: 'ticket-1', requestId: 'req-1' })
  const completed = acceptedResultFromTicket(requested.payload.ticket, 9, { terminalEvidenceRef: 'term:req-1' })
  return [
    ...prefix,
    requested,
    completed,
    envelope('task/completed', 10, { snapshot: SNAP, verification: 'verified' }),
  ]
}

describe('task reducer', () => {
  it('replays the same events to the same state', () => {
    expect(reduceAll(happyPath())).toEqual(reduceAll(happyPath()))
    expect(reduceAll(happyPath()).phase).toBe('COMPLETED')
  })

  it('treats duplicate event ids as idempotent', () => {
    const first = reduce(undefined, created())
    expect(reduce(first, created())).toEqual(first)
  })

  it('rejects an old revision completing a newer task', () => {
    const state = reduceAll([
      created(),
      envelope('requirements/revised', 2, { reason: 'user added a constraint' }, { revision: 2 }),
      envelope('intent/chosen', 3, { intent: 'DIRECT' }, { revision: 2 }),
    ])
    expect(state.revision).toBe(2)
    expect(() => reduce(state, envelope('task/completed', 4, { snapshot: SNAP, verification: 'verified' }, { revision: 1 })))
      .toThrowError(FusionError)
    try {
      reduce(state, envelope('task/completed', 4, { snapshot: SNAP, verification: 'verified' }, { revision: 1 }))
    } catch (error) {
      expect((error as FusionError).code).toBe(REVISION_STALE)
    }
  })

  it('rejects a late report for a stale revision', () => {
    const state = reduceAll([
      created(),
      envelope('requirements/revised', 2, { reason: 'steer' }, { revision: 2 }),
    ])
    expect(() => reduce(state, envelope('report/validated', 3, { operationId: order().operationId, report }, { revision: 2 })))
      .toThrowError(/report revision 1/)
  })

  it('does not complete while an effect is unknown', () => {
    const state = reduceAll([
      created(),
      envelope('intent/chosen', 2, { intent: 'DIRECT' }),
      envelope('effect/outcome-unknown', 3, { operationId: order().operationId, reason: 'crash after dispatch' }),
    ])
    expect(state.phase).toBe('NEEDS_DECISION')
    expect(() => reduce(state, envelope('task/completed', 4, { snapshot: SNAP, verification: 'partial' }))).toThrowError(/OUTCOME_UNKNOWN/)
  })

  it('keeps DIRECT from forcing a worker', () => {
    const state = reduceAll([
      created(),
      envelope('intent/chosen', 2, { intent: 'DIRECT' }),
    ])
    expect(state.phase).toBe('DIRECT')
    expect(state.reservedChild).toBeUndefined()
  })

  it('maps stop then cancel without inventing a new child', () => {
    const state = reduceAll([
      created(),
      envelope('work-order/prepared', 2, { order: order(), reservedChild: CHILD }),
      envelope('child/accepted', 3, { operationId: order().operationId, child: CHILD, messageId: 'm1' }),
      envelope('task/stop-requested', 4, { intent: 'cancel' }),
      envelope('task/cancelled', 5, { reason: 'user cancel' }),
    ])
    expect(state.phase).toBe('CANCELLED')
    expect(state.acceptedChild).toBe(CHILD)
  })
})
