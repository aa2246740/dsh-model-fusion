import type { ExplorationReport, ExplorationSource, WorkOrder } from '../contracts.js';
import type { SqliteFusionStore } from '../task/sqlite-store.js';
import type { WorkspaceSnapshot } from './workspace.js';
/** Bounded, source-backed handoff. No commands, guessed snippets or verification claims. */
export declare function captureExploration(store: SqliteFusionStore, order: WorkOrder, snapshot: WorkspaceSnapshot, submitted: Pick<ExplorationReport, 'summary' | 'status' | 'unresolved'>, sources: readonly ExplorationSource[]): ExplorationReport;
