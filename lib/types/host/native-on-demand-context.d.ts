import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Role } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
import type { NativeTaskContext } from './native-task-context.js';
/** No per-step snapshots. Emit a compact pointer only after loss of context. */
export declare class NativeOnDemandContext {
    #private;
    readonly store: SqliteFusionStore;
    readonly facts: NativeTaskContext;
    constructor(store: SqliteFusionStore, facts: NativeTaskContext);
    private id;
    message(agent: Agent, binding: SessionBinding, role: Role): ({
        content: {
            type: "text";
            text: string;
        }[];
        source: {
            kind: "plugin:dsh-model-fusion";
            form: "snapshot";
            sections: {
                name: string;
                text: string;
            }[];
        };
    } & Pick<import("@deepseek-ai/dsh-llm").UserMessage, "id" | "role">) | undefined;
    blocked(agent: Agent, binding: SessionBinding): string | undefined;
    read(agent: Agent, binding: SessionBinding, role: Role, offset?: number, limit?: number): {
        bytes: number;
        encoding: string;
        offsetUnit: string;
        offset: number;
        totalCharacters: number;
        text: string;
        truncated: boolean;
        nextOffset: number | null;
        taskId: import("../contracts.js").TaskId;
    };
}
