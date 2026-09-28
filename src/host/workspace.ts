import { execFileSync } from 'node:child_process'
import type { Stats } from 'node:fs'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SnapshotId } from '../contracts.js'
import { digestOf, sha256Hex } from '../digest.js'

// These directories are not source evidence. The manifest records the exclusion
// contract explicitly; callers must not describe this as a whole-disk snapshot.
export const SNAPSHOT_EXCLUSIONS = ['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'] as const
// Outside a git work tree there are no ignore rules to consult; also skip common environment and cache directories.
export const FALLBACK_EXCLUSIONS = [...SNAPSHOT_EXCLUSIONS, '.venv', 'venv', '.tox', '.nox', '.eggs', '.gradle', '.next', '.turbo', '.cache'] as const
export interface WorkspaceEntry { path: string; kind: 'file' | 'symlink'; digest: string; executable: boolean }
export interface WorkspaceSnapshot {
  schemaVersion: 1
  root: string
  excludedDirectoryNames: readonly string[]
  /** Present when the entry list came from git (tracked + untracked, minus the repository's ignore rules). */
  ignoreRules?: 'git-exclude-standard'
  entries: readonly WorkspaceEntry[]
  id: SnapshotId
}

export function workspacePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('Workspace paths must be nonempty relative paths')
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes the workspace')
  // Never traverse a link when interpreting an allowed path or verifier input.
  let current = root
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Workspace path traverses a symlink') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return absolute
}

const MAX_ENTRIES = 200_000
const LARGE_FILE = 16 * 1024 * 1024

/**
 * Source files git would consider (tracked plus untracked, minus the repository's ignore rules), relative
 * to root; undefined outside a git work tree or without git. Ignore rules are the project's own statement
 * of what is not source (virtualenvs, build output, caches), so no per-ecosystem list has to guess.
 */
function gitSourceFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    return [...new Set(out.toString('utf8').split('\0').filter(Boolean))].sort()
  } catch { return undefined }
}

export function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  const root = realpathSync.native(cwd)
  const entries: WorkspaceEntry[] = []
  const excluded = (path: string) => path.split('/').some(part => (SNAPSHOT_EXCLUSIONS as readonly string[]).includes(part))
  function add(full: string, path: string, stat: Stats): void {
    if (stat.isSymbolicLink()) {
      entries.push({ path, kind: 'symlink', digest: sha256Hex(readlinkSync(full)), executable: false })
    } else if (stat.isFile()) {
      // A very large file (dataset, binary asset) is fingerprinted by size and mtime instead of content.
      const large = stat.size > LARGE_FILE
      const contents = large ? undefined : readFileSync(full)
      const after = lstatSync(full)
      if (after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.size !== (contents?.length ?? stat.size)) throw new Error('Workspace changed while taking the snapshot')
      entries.push({ path, kind: 'file', digest: contents ? sha256Hex(contents) : sha256Hex(`large:${stat.size}:${stat.mtimeMs}`), executable: Boolean(stat.mode & 0o111) })
    } else if (!stat.isDirectory()) { throw new Error(`Unsupported source file type: ${path}`) }
    if (entries.length > MAX_ENTRIES) throw new Error('Workspace exceeds the bounded file manifest; choose a smaller project root')
  }
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name)
      const stat = lstatSync(full)
      if (stat.isDirectory()) { if (!(FALLBACK_EXCLUSIONS as readonly string[]).includes(name)) visit(full); continue }
      add(full, relative(root, full).split(sep).join('/'), stat)
    }
  }
  const listed = gitSourceFiles(root)
  if (listed) {
    for (const path of listed) {
      if (excluded(path)) continue
      const full = join(root, ...path.split('/'))
      let stat: Stats
      try { stat = lstatSync(full) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (!stat.isDirectory()) add(full, path, stat) // a nested repository (gitlink) is not traversed
    }
  } else visit(root)
  const manifest = { schemaVersion: 1 as const, root, excludedDirectoryNames: listed ? SNAPSHOT_EXCLUSIONS : FALLBACK_EXCLUSIONS,
    ...(listed ? { ignoreRules: 'git-exclude-standard' as const } : {}), entries }
  return { ...manifest, id: SnapshotId(`source:${digestOf(manifest)}`) }
}

export function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  if (before.root !== after.root) throw new Error('Workspace root changed')
  const old = new Map(before.entries.map(entry => [entry.path, digestOf(entry)]))
  const now = new Map(after.entries.map(entry => [entry.path, digestOf(entry)]))
  return [...new Set([...old.keys(), ...now.keys()])].filter(path => old.get(path) !== now.get(path)).sort()
}

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
export function normalizeRelativePath(path: string): string | undefined {
  if (!path || path.includes('\0') || isAbsolute(path) || (process.platform === 'win32' && /^[a-z]:/i.test(path))) return undefined
  const segments: string[] = []
  for (const segment of path.split(process.platform === 'win32' ? /[\\/]+/ : /\//)) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.pop()) return undefined }
    else segments.push(segment)
  }
  return segments.join('/')
}

export function pathAllowed(path: string, allowed: readonly string[]): boolean {
  const normalized = normalizeRelativePath(path)
  if (normalized === undefined) return false
  // `'.'` normalizes to the root: it is the legitimate whole-workspace grant. An empty
  // or absolute allowed entry instead fails normalization above and never authorizes.
  return allowed.some(raw => {
    const prefix = normalizeRelativePath(raw)
    return prefix !== undefined && (prefix === '' || normalized === prefix || normalized.startsWith(`${prefix}/`))
  })
}
