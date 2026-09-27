import { SnapshotId } from '../contracts.js';
export declare const SNAPSHOT_EXCLUSIONS: readonly [".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"];
export declare const FALLBACK_EXCLUSIONS: readonly [".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".tox", ".nox", ".eggs", ".gradle", ".next", ".turbo", ".cache"];
export interface WorkspaceEntry {
    path: string;
    kind: 'file' | 'symlink';
    digest: string;
    executable: boolean;
}
export interface WorkspaceSnapshot {
    schemaVersion: 1;
    root: string;
    excludedDirectoryNames: readonly string[];
    /** Present when the entry list came from git (tracked + untracked, minus the repository's ignore rules). */
    ignoreRules?: 'git-exclude-standard';
    entries: readonly WorkspaceEntry[];
    id: SnapshotId;
}
export declare function workspacePath(root: string, path: string): string;
export declare function snapshotWorkspace(cwd: string): WorkspaceSnapshot;
export declare function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[];
export declare function pathAllowed(path: string, allowed: readonly string[]): boolean;
