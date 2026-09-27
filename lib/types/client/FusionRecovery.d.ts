import type { FusionStatus } from '../status.js';
export declare function FusionRecovery({ sessionId, task }: {
    sessionId: string;
    task: NonNullable<FusionStatus['task']>;
}): import("react").JSX.Element;
