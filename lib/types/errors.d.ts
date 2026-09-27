export declare class FusionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare const FUSION_CONTEXT_BUDGET = "FUSION_CONTEXT_BUDGET";
export declare const REVISION_CONFLICT = "REVISION_CONFLICT";
export declare const REVISION_STALE = "REVISION_STALE";
export declare const EVENT_CONFLICT = "EVENT_CONFLICT";
export declare const FLUSH_FAILED = "FLUSH_FAILED";
export declare const CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH";
export declare const LEASE_BUSY = "LEASE_BUSY";
export declare const LEASE_GENERATION = "LEASE_GENERATION";
export declare const PROFILE_UNAVAILABLE = "PROFILE_UNAVAILABLE";
export declare const SPEND_UNAUTHORIZED = "SPEND_UNAUTHORIZED";
export declare const APPROVAL_SCOPE = "APPROVAL_SCOPE";
export declare const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";
export declare const NEEDS_REPAIR = "NEEDS_REPAIR";
export declare const USAGE_MERGE_CONFLICT = "USAGE_MERGE_CONFLICT";
export declare const USAGE_LEDGER_REQUIRED = "USAGE_LEDGER_REQUIRED";
export declare const CONTROL_BLOCKED = "CONTROL_BLOCKED";
export declare const REVIEW_RESULT_CONFLICT = "REVIEW_RESULT_CONFLICT";
export declare const REVIEW_TICKET_REQUIRED = "REVIEW_TICKET_REQUIRED";
export declare const WORK_ORDER_CONFLICT = "WORK_ORDER_CONFLICT";
export declare const STORE_MIGRATION_REQUIRED = "STORE_MIGRATION_REQUIRED";
