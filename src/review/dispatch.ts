import type { FusionEvent, ReviewTicket, TaskId } from '../contracts.js'
import { EVENT_CONFLICT, FusionError } from '../errors.js'
import type { ReviewClassification } from './protocol.js'
import { captureTicket, createReviewTicket, resultFromCapturedTicket, reviewOutboxRow, reviewRequestedEvent } from './ticket.js'
import type { FusionStore } from '../task/store.js'

/**
 * Offline producer: persist the captured ticket and outbox row before any adapter send.
 * The model callback may read the latest TaskState only for seq/CAS.
 */
export function persistReviewRequest(
  store: FusionStore,
  taskId: TaskId,
  ids: { ticketId: string; requestId: string },
  payloadRef: string,
): Readonly<ReviewTicket> {
  const current = store.load(taskId)
  if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`)
  const ticket = captureTicket(createReviewTicket(current, ids))
  const requested = reviewRequestedEvent(current, current.seq + 1, ids)
  store.transact(taskId, current.seq, persisted => ({
    events: [requested],
    outbox: [...persisted.outbox, reviewOutboxRow(ticket, payloadRef)],
  }))
  return ticket
}

export function loadReviewOutboxByRequestId(store: FusionStore, taskId: TaskId, requestId: string) {
  const row = store.outbox(taskId).find(item => item.requestId === requestId || item.ticket?.requestId === requestId)
  if (!row?.ticket) throw new FusionError(EVENT_CONFLICT, `review outbox missing for ${requestId}`)
  return { row, ticket: captureTicket(row.ticket) }
}

export function appendCapturedReviewResult(
  store: FusionStore,
  taskId: TaskId,
  ticket: Readonly<ReviewTicket>,
  outcome: { requestId: string; terminalEvidenceRef: string; classification: ReviewClassification },
): ReturnType<FusionStore['append']> {
  const current = store.load(taskId)
  if (!current) throw new FusionError(EVENT_CONFLICT, `unknown task ${taskId}`)
  const event: FusionEvent = resultFromCapturedTicket(ticket, outcome, {
    eventId: `review-completed-${ticket.requestId}-${current.seq + 1}`,
    seq: current.seq + 1,
    createdAt: new Date().toISOString(),
  })
  return store.append(taskId, current.revision, [event])
}
