import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
export declare const enforcedWorkflow: (binding: SessionBinding) => boolean;
/** v3 keeps every v2 mechanism and adds role separation (see native-role-sandbox). */
export declare const adaptiveWorkflow: (binding: SessionBinding) => boolean;
export interface ProgressWindow {
    schemaVersion: 1;
    milestone: string;
    recent: string[];
    tinyRead?: {
        path: string;
        count: number;
    };
}
export interface ProgressObservation {
    milestone: string;
    fingerprint?: string;
    tinyPath?: string;
    role: Role;
}
/** Results, not model explanations, drive this bounded and persistable detector. */
export declare function advanceProgress(previous: ProgressWindow | undefined, observation: ProgressObservation): {
    window: ProgressWindow;
    stalled: boolean;
};
/** Only public execution results and durable task facts enter the workflow controller. */
export declare class NativeWorkflow {
    readonly store: SqliteFusionStore;
    constructor(store: SqliteFusionStore);
    milestone(binding: SessionBinding): string;
    observe(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>, binding: SessionBinding, role: Role, read: boolean): boolean;
    /** One local replanning opportunity, not an immediate request for user intervention. */
    repairProgress(agent: Agent, binding: SessionBinding, role: Role): boolean;
    denyEffect(binding: SessionBinding): string;
    deniedEffect(binding: SessionBinding): boolean;
    /** At most one repair generation per role and durable milestone, surviving reloads. */
    repairStop(agent: Agent, binding: SessionBinding, role: Role, instruction: string): boolean;
}
