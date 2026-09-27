import type { FusionEvent, OutboxRow, ReportSubject, ReviewReadinessReceipt, ReviewTicket, TaskId, WorkerReport } from '../contracts.js';
import type { ReviewClassification } from './protocol.js';
import type { TaskState } from '../task/state.js';
export declare function reportSubject(taskId: TaskId, report: WorkerReport): ReportSubject;
export declare function sameSubject(left: ReportSubject, right: ReportSubject): boolean;
export declare function reviewReadinessReceipt(subject: ReportSubject): ReviewReadinessReceipt;
export declare function captureTicket(ticket: ReviewTicket): Readonly<ReviewTicket>;
export declare function createReviewTicket(state: TaskState, ids: {
    ticketId: string;
    requestId: string;
}): ReviewTicket;
export declare function reviewRequestedEvent(state: TaskState, seq: number, ids: {
    ticketId: string;
    requestId: string;
}, extras?: Partial<Pick<FusionEvent, 'id' | 'revision' | 'createdAt' | 'causeId'>>): Extract<FusionEvent, {
    type: 'review/requested';
}>;
export declare function reviewOutboxRow(ticket: Readonly<ReviewTicket>, payloadRef: string): OutboxRow;
/** Callback constructor. No TaskState argument: the producer cannot rebind to the latest task. */
export declare function resultFromCapturedTicket(ticket: Readonly<ReviewTicket>, outcome: {
    requestId: string;
    terminalEvidenceRef: string;
    classification: ReviewClassification;
}, envelope: {
    eventId: string;
    seq: number;
    createdAt: string;
}): Extract<FusionEvent, {
    type: 'review/completed';
}>;
/** Call at review dispatch AND immediately before committing verified completion. */
export declare function assertCurrentSubject(state: TaskState, ticket: ReviewTicket, actualSnapshot: ReportSubject['snapshot']): void;
