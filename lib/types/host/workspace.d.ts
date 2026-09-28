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
/**
 * Workspace-relative allowlist check. `/` always separates segments; `\` is a
 * separator only on Windows — on POSIX it is a legal filename character, so
 * `src\file.ts` must not match a `src` grant there. `.`/`..` segments then
 * resolve lexically, so `src/../outside` (and its backslash form on Windows)
 * never matches a `src` grant. workspacePath only bounds a path to the
 * workspace root; membership in allowedPaths is decided here. Absolute paths
 * (`/x`, `C:\x`, drive-relative `C:x`, UNC), empty paths and NUL are not
 * workspace-relative and never normalize.
 */
export declare function normalizeRelativePath(path: string): string | undefined;
export declare function pathAllowed(path: string, allowed: readonly string[]): boolean;
