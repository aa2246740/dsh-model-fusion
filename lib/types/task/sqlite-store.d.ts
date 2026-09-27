import type { ArtifactRef, FusionEvent, OutboxRow, OutboxState, TaskId } from '../contracts.js';
import type { PersistedTask, TaskState } from './state.js';
import type { ArtifactRecord, FusionStore } from './store.js';
/** Durable Host backend. Every read is fresh; CAS and outbox writes share one transaction. */
export declare class SqliteFusionStore implements FusionStore {
    #private;
    readonly filename: string;
    constructor(filename: string);
    close(): void;
    listTaskIds(): readonly TaskId[];
    listDocumentIds(prefix: string): readonly string[];
    load(taskId: TaskId): TaskState | undefined;
    events(taskId: TaskId): readonly FusionEvent[];
    replay(taskId: TaskId): TaskState;
    create(event: Extract<FusionEvent, {
        type: 'task/created';
    }>): TaskState;
    transact(taskId: TaskId, expectedSeq: number, mutate: (current: PersistedTask) => {
        events?: readonly FusionEvent[];
        outbox?: readonly OutboxRow[];
    }): TaskState;
    append(taskId: TaskId, expectedRevision: number, events: readonly FusionEvent[]): TaskState;
    putArtifact(taskId: TaskId, bytes: Uint8Array, mediaType: string): ArtifactRef;
    /** One atomic metadata update for a bounded workspace evidence batch. */
    putArtifacts(taskId: TaskId, inputs: readonly {
        bytes: Uint8Array;
        mediaType: string;
    }[]): ArtifactRef[];
    /** Load owned evidence bytes and verify content before trusting the reference. */
    readArtifact(taskId: TaskId, digest: string): Uint8Array;
    readArtifacts(taskId: TaskId, digests: readonly string[]): Uint8Array[];
    prepareOutbox(row: OutboxRow): OutboxRow;
    advanceOutbox(taskId: TaskId, operationId: string, from: OutboxState, to: OutboxState, patch?: Partial<OutboxRow>): OutboxRow;
    outbox(taskId: TaskId): readonly OutboxRow[];
    artifacts(taskId: TaskId): readonly ArtifactRecord[];
    /** Host binding / usage documents require caller-side schema validation after loading. */
    readDocument(id: string): {
        revision: number;
        value: unknown;
    } | undefined;
    /** Compare-and-swap prevents an old Host instance overwriting a newer selection or bill. */
    writeDocument(id: string, expectedRevision: number, value: unknown): number;
    writeDocuments(rows: readonly {
        id: string;
        expectedRevision: number;
        value: unknown;
    }[]): number[];
}
