import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { SessionBinding } from './bindings.js';
/** Reduce only our Worker's runtime closing notice, never its structured report. */
export declare class NativeWorkerNotices {
    readonly store: SqliteFusionStore;
    constructor(store: SqliteFusionStore);
    project(agent: Agent, binding: SessionBinding, original: UserMessage): UserMessage;
    /** Replace retained legacy notices before the native compactor reads history.
     * Public surface replacement preserves the original append-only event and
     * cites it. Already compacted prose cannot be safely reverse-transformed.
     */
    projectHistory(agent: Agent, binding: SessionBinding): void;
}
