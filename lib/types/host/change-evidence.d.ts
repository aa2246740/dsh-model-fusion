import type { ArtifactRef, SnapshotId, TaskId } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { WorkspaceEntry, WorkspaceSnapshot } from './workspace.js';
export interface ChangeBase {
    schemaVersion: 1;
    snapshot: SnapshotId;
    contents: Record<string, ArtifactRef>;
}
export declare function captureChangeBase(store: SqliteFusionStore, taskId: TaskId, base: WorkspaceSnapshot, allowed: readonly string[]): ChangeBase;
export interface ChangeDiff {
    path: string;
    status: 'text' | 'binary' | 'type-change' | 'unavailable-base';
    before?: {
        entry: WorkspaceEntry;
        content?: ArtifactRef;
    };
    after?: {
        entry: WorkspaceEntry;
        content: ArtifactRef;
    };
    patch?: ArtifactRef;
}
export declare function saveChangeManifest(store: SqliteFusionStore, taskId: TaskId, base: WorkspaceSnapshot, candidate: WorkspaceSnapshot, captured?: ChangeBase): ArtifactRef;
