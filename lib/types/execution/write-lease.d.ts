import type { OperationId, SessionId, TaskId, WriteLease } from '../contracts.js';
export interface LeaseRecord extends WriteLease {
    readonly owner: string;
    readonly pid: number;
    readonly acquiredAt: string;
    readonly liveProcessRefs: readonly number[];
}
export declare function canonicalWorkspace(cwd: string): string;
export declare function leasePath(workspaceId: string, root?: string): string;
export declare class WorkspaceWriteLease {
    #private;
    private readonly root;
    constructor(root?: string);
    acquire(input: {
        cwd: string;
        holder: SessionId;
        taskId: TaskId;
        operationId: OperationId;
        liveProcessRefs?: readonly number[];
    }): LeaseRecord;
    assertGeneration(lease: WriteLease, generation: number): void;
    stillHeld(lease: LeaseRecord): boolean;
    /** Caller must prove native Worker/tool quiescence before releasing. */
    release(lease: LeaseRecord): void;
    /** Trusted recovery inspection. A dead PID by itself never authorizes stealing. */
    current(cwd: string): LeaseRecord | undefined;
}
export declare function classifyEffect(kind: 'read-tool' | 'write-tool' | 'unknown-shell'): 'read' | 'write';
