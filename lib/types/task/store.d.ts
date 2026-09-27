import type { ArtifactRef, FusionEvent, OutboxRow, OutboxState, TaskId } from '../contracts.js';
import type { PersistedTask, TaskState } from './state.js';
export interface StoreIo {
    existsSync(path: string): boolean;
    mkdirSync(path: string): void;
    readFileSync(path: string): string;
    writeFileSync(path: string, data: string | Uint8Array): void;
    renameSync(from: string, to: string): void;
    rmSync(path: string): void;
}
export declare const nodeIo: StoreIo;
export interface ArtifactRecord extends ArtifactRef {
    readonly storageRef: string;
}
export declare const STORE_PROJECTION_VERSION = 2;
export interface DiskSnapshot {
    readonly projectionVersion: typeof STORE_PROJECTION_VERSION;
    readonly checksum: string;
    readonly persisted: PersistedTask;
    readonly artifacts: readonly ArtifactRecord[];
}
/** The reducer and review producer share this port across file and transactional stores. */
export type FusionStore = Pick<FileFusionStore, 'load' | 'replay' | 'create' | 'transact' | 'append' | 'putArtifact' | 'prepareOutbox' | 'advanceOutbox' | 'outbox' | 'artifacts'>;
export declare class FileFusionStore {
    #private;
    readonly root: string;
    readonly io: StoreIo;
    constructor(root: string, io?: StoreIo);
    load(taskId: TaskId): TaskState | undefined;
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
    prepareOutbox(row: OutboxRow): OutboxRow;
    advanceOutbox(taskId: TaskId, operationId: string, from: OutboxState, to: OutboxState, patch?: Partial<OutboxRow>): OutboxRow;
    outbox(taskId: TaskId): readonly OutboxRow[];
    artifacts(taskId: TaskId): readonly ArtifactRecord[];
}
/** Validate before either backend admits a persisted execution projection. */
export declare function decodeStoreSnapshot(raw: string, taskId: TaskId): DiskSnapshot;
export declare function requireStorageProjectionVersion(raw: unknown): asserts raw is DiskSnapshot;
export declare function failingRenameIo(base: StoreIo, failOnce?: boolean): StoreIo;
