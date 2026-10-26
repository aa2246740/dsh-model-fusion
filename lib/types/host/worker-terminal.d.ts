/** What fusion_wait should do once the resident Worker handle is already gone. */
export declare function absentWorkerOutcome(input: {
    pendingEffects: number;
    outcomeUnknown: boolean;
    submitted: boolean;
}): {
    kind: 'recovery';
    reason: string;
} | {
    kind: 'collect-report';
} | {
    kind: 'incomplete';
};
/** Settlement notice text. It must match whether a report was persisted, and must not send the Lead back to a disposed Worker. */
export declare function workerSettlementGuidance(submitted: boolean): string;
/**
 * How to describe a Worker model-control wait to the Lead.
 * WORKFLOW_INCOMPLETE and NO_PROGRESS are missing work, not an unavailable provider.
 */
export declare function workerStopExplanation(code: string): {
    reasonCode: string;
    next: string;
};
/** Continue/switch is refused before the route is written. Say so when a switch was requested. */
export declare function unsettledContinuationError(switching: boolean): {
    zh: string;
    en: string;
};
