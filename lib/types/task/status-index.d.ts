import type { DatabaseSync } from 'node:sqlite';
import type { FusionStatus } from '../status.js';
type TaskStatus = NonNullable<FusionStatus['task']>;
export declare class StatusDataError extends Error {
}
export declare class StatusPending extends Error {
    readonly task: string;
    constructor(task: string);
}
/** Rebuildable read model. Triggers also track writes/deletes by older plugin processes. */
export declare class StatusIndex {
    #private;
    readonly db: DatabaseSync;
    constructor(db: DatabaseSync);
    /** Call inside the document transaction, after the source row is written. */
    sync(id: string): void;
    /** Each batch is its own transaction, so a legacy backfill does not monopolize the writer lock. */
    flushBatch(task: string): boolean;
    /** Bounded memory even for a legacy database; the surrounding transaction is atomic. */
    flush(task?: string): void;
    rebuild(): void;
    read(task: string): Pick<TaskStatus, 'usage' | 'requests' | 'tools' | 'contexts' | 'unsettledTools'> & {
        checking: boolean;
    };
    workerConversations(task: string): number;
    hasConversation(task: string, session: string): boolean;
}
export {};
