import type { RoleContextPolicy, TokenMeasurement } from '../contracts.js';
export interface RequestParts {
    systemTokens: number;
    messageTokens: number;
    toolSchemaTokens: number;
    cacheReadTokens: number;
    reservedOutputTokens: number;
    contextWindow: number;
    quality: TokenMeasurement['quality'];
}
export declare function safetyTokens(contextWindow: number, policy: RoleContextPolicy, quality: TokenMeasurement['quality']): number;
/** Output reservation that fits the disclosed window. Leaves half the usable window for input. */
export declare function fittedOutputReservation(contextWindow: number): number;
export declare function requestOutputReservation(contextWindow: number, requested?: number, adapterDefault?: number, testedCap?: number, fallback?: number): number;
export declare function inputBudget(policy: RoleContextPolicy, contextWindow: number, maxOutput: number, quality?: TokenMeasurement['quality']): number;
export declare function measureRequest(parts: RequestParts, policy: RoleContextPolicy): TokenMeasurement;
export declare function assertFinalBudget(measurement: TokenMeasurement, policy: RoleContextPolicy): void;
export interface RecoveryAttempt {
    readonly projectionTokens: number;
}
export declare function boundedOverflowRecovery(attempts: readonly RecoveryAttempt[]): 'continue' | 'needs-decision';
