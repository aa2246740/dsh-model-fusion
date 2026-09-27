import type { ReviewTicket, TaskId } from '../contracts.js';
import type { ReviewClassification } from './protocol.js';
import type { FusionStore } from '../task/store.js';
/**
 * Offline producer: persist the captured ticket and outbox row before any adapter send.
 * The model callback may read the latest TaskState only for seq/CAS.
 */
export declare function persistReviewRequest(store: FusionStore, taskId: TaskId, ids: {
    ticketId: string;
    requestId: string;
}, payloadRef: string): Readonly<ReviewTicket>;
export declare function loadReviewOutboxByRequestId(store: FusionStore, taskId: TaskId, requestId: string): {
    row: import("../contracts.js").OutboxRow;
    ticket: Readonly<ReviewTicket>;
};
export declare function appendCapturedReviewResult(store: FusionStore, taskId: TaskId, ticket: Readonly<ReviewTicket>, outcome: {
    requestId: string;
    terminalEvidenceRef: string;
    classification: ReviewClassification;
}): ReturnType<FusionStore['append']>;
