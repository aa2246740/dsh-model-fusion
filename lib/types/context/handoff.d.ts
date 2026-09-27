/**
 * Upper bound on recent conversation text carried into a Sidekick brief after compaction: about 10k tokens,
 * enough for the latest exchanges while leaving most of the Sidekick's context for the task itself.
 */
export declare const HANDOFF_CONTENT_BYTES = 40000;
/** Content bytes only: envelopes and independently retained task facts are extra. */
export declare function recentHandoffSuffix<T extends {
    readonly content: string;
}>(records: readonly T[]): {
    policy: "recent-whole-records-utf8-v1";
    contentByteBudget: number;
    totalRecords: number;
    omittedRecords: number;
    totalContentBytes: number;
    retainedContentBytes: number;
    records: T[];
};
