import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PairProfile } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
/** A declared benchmark treatment, never installed in product sessions. */
export declare const naivePrompts: {
    lead: string;
    worker: string;
};
export interface NaiveDelegation {
    ordinal: number;
    callId: string;
    briefDigest: string;
    startedAt: string;
    endedAt: string | null;
    childSessionId: string | null;
    parentSessionId: string;
    state: 'starting' | 'running' | 'settled' | 'failed';
    stopReason: string | null;
    disposed: boolean;
    failure: string | null;
}
/** Simple sequential coordinator using the native one-shot child lifecycle. */
export declare class NaiveCoordinator {
    #private;
    readonly ctx: Context;
    readonly parent: Agent;
    readonly store: SqliteFusionStore;
    readonly profile: PairProfile;
    readonly workerMaxTokens: number;
    readonly tools: readonly string[];
    readonly delegations: NaiveDelegation[];
    constructor(ctx: Context, parent: Agent, store: SqliteFusionStore, profile: PairProfile, workerMaxTokens: number, tools?: readonly string[]);
    owns(agent: Agent): boolean;
    assertReady(): void;
    close(): Promise<void>;
}
