import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ReviewTicket, TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
/** Capture before the Lead request starts; later tool callbacks cannot bind to a newer report. */
export declare function captureNativeReviewRequest(store: SqliteFusionStore, agent: Agent, turn: number, step: number, ticket: ReviewTicket): void;
export declare function nativeReviewProof(store: SqliteFusionStore, taskId: TaskId, exec: ToolExecution): {
    ticket: Readonly<ReviewTicket>;
    terminalEvidenceRef: string;
    finishReason: 'tool_calls' | 'stop';
};
