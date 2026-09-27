import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ArtifactRef, SnapshotId, TaskId } from '../contracts.js'
import { sha256Hex } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { evidenceText } from './evidence-page.js'
import { changedPaths, pathAllowed, workspacePath } from './workspace.js'
import type { WorkspaceEntry, WorkspaceSnapshot } from './workspace.js'

export interface ChangeBase {
  schemaVersion: 1
  snapshot: SnapshotId
  contents: Record<string, ArtifactRef>
}

/** Read only the exact leaf described by the snapshot, never its symlink target. */
function readEntry(snapshot: WorkspaceSnapshot, entry: WorkspaceEntry): Buffer {
  if (realpathSync.native(snapshot.root) !== snapshot.root) throw new Error('Evidence workspace root changed')
  const path = join(workspacePath(snapshot.root, dirname(entry.path)), basename(entry.path))
  const before = lstatSync(path)
  let bytes: Buffer
  if (entry.kind === 'symlink') {
    if (!before.isSymbolicLink()) throw new Error('Evidence file kind changed')
    bytes = readlinkSync(path, { encoding: 'buffer' })
  } else {
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error('Evidence file is not a bounded regular source file')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Evidence source changed while opening')
      bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!count) throw new Error('Evidence source shrank while reading')
        offset += count
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error('Evidence source grew while reading')
      const after = fstatSync(fd)
      if (after.size !== bytes.length || after.mtimeMs !== opened.mtimeMs) throw new Error('Evidence source changed while reading')
    } finally { closeSync(fd) }
  }
  const after = lstatSync(path)
  if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs
    || (entry.kind === 'file' && Boolean(after.mode & 0o111) !== entry.executable)
    || sha256Hex(bytes) !== entry.digest) throw new Error('Evidence bytes do not match the frozen snapshot')
  // Recheck parents after reading; a replacement must never become trusted evidence.
  workspacePath(snapshot.root, dirname(entry.path))
  if (realpathSync.native(snapshot.root) !== snapshot.root) throw new Error('Evidence workspace root changed')
  return bytes
}

export function captureChangeBase(store: SqliteFusionStore, taskId: TaskId, base: WorkspaceSnapshot, allowed: readonly string[]): ChangeBase {
  const entries = base.entries.filter(entry => pathAllowed(entry.path, allowed))
  const refs = store.putArtifacts(taskId, entries.map(entry => ({ bytes: readEntry(base, entry), mediaType: 'application/octet-stream' })))
  return { schemaVersion: 1, snapshot: base.id, contents: Object.fromEntries(entries.map((entry, i) => [entry.path, refs[i]])) }
}

function quotePath(path: string): string {
  const bytes = Buffer.from(path)
  if (bytes.every(byte => byte > 32 && byte < 127 && byte !== 34 && byte !== 92)) return path
  return '"' + Array.from(bytes, byte => byte === 34 || byte === 92 ? '\\' + String.fromCharCode(byte)
    : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0')).join('') + '"'
}
const mode = (entry: WorkspaceEntry) => entry.kind === 'symlink' ? '120000' : entry.executable ? '100755' : '100644'

/** A full, applicable single hunk, trimmed only at unchanged leading/trailing lines. */
function patch(path: string, before: WorkspaceEntry | undefined, after: WorkspaceEntry | undefined, oldText: string, newText: string): string {
  const a = quotePath(`a/${path}`), b = quotePath(`b/${path}`)
  let output = `diff --git ${a} ${b}\n`
  if (!before) output += `new file mode ${mode(after!)}\n`
  else if (!after) output += `deleted file mode ${mode(before)}\n`
  else if (mode(before) !== mode(after)) output += `old mode ${mode(before)}\nnew mode ${mode(after)}\n`
  if (oldText === newText) return output
  const oldLines = oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [], newLines = newText.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let prefix = 0, suffix = 0
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++
  while (suffix < Math.min(oldLines.length, newLines.length) - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++
  const start = Math.max(0, prefix - 3), oldEnd = oldLines.length - Math.max(0, suffix - 3), newEnd = newLines.length - Math.max(0, suffix - 3)
  const line = (tag: string, value: string) => tag + value + (value.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')
  output += `--- ${before ? a : '/dev/null'}\n+++ ${after ? b : '/dev/null'}\n@@ -${oldEnd === start ? 0 : start + 1},${oldEnd - start} +${newEnd === start ? 0 : start + 1},${newEnd - start} @@\n`
  for (let i = start; i < prefix; i++) output += line(' ', oldLines[i])
  for (let i = prefix; i < oldLines.length - suffix; i++) output += line('-', oldLines[i])
  for (let i = prefix; i < newLines.length - suffix; i++) output += line('+', newLines[i])
  for (let i = oldLines.length - suffix; i < oldEnd; i++) output += line(' ', oldLines[i])
  return output
}

export interface ChangeDiff {
  path: string
  status: 'text' | 'binary' | 'type-change' | 'unavailable-base'
  before?: { entry: WorkspaceEntry; content?: ArtifactRef }
  after?: { entry: WorkspaceEntry; content: ArtifactRef }
  patch?: ArtifactRef
}

export function saveChangeManifest(store: SqliteFusionStore, taskId: TaskId, base: WorkspaceSnapshot, candidate: WorkspaceSnapshot, captured?: ChangeBase): ArtifactRef {
  if (captured && (captured.schemaVersion !== 1 || captured.snapshot !== base.id)) throw new Error('Change evidence belongs to another base snapshot')
  const changes = changedPaths(base, candidate)
  const old = new Map(base.entries.map(entry => [entry.path, entry])), now = new Map(candidate.entries.map(entry => [entry.path, entry]))
  const baseRefs = changes.flatMap(path => {
    const ref = old.has(path) && captured && Object.hasOwn(captured.contents, path) ? captured.contents[path] : undefined
    return ref ? [ref] : []
  })
  const baseBytes = new Map(store.readArtifacts(taskId, baseRefs.map(ref => ref.id)).map((bytes, i) => [baseRefs[i].id, bytes]))
  const pending: { bytes: Uint8Array; mediaType: string }[] = []
  const prepared = changes.map(path => {
    const before = old.get(path), after = now.get(path)
    const beforeRef = before && captured && Object.hasOwn(captured.contents, path) ? captured.contents[path] : undefined
    const oldBytes = beforeRef ? baseBytes.get(beforeRef.id) : undefined
    if (beforeRef && (!before || beforeRef.digest !== before.digest || sha256Hex(oldBytes!) !== before.digest)) throw new Error('Change evidence does not match the base file')
    if (before && captured && !beforeRef) throw new Error('Frozen change evidence is missing the base file')
    const newBytes = after ? readEntry(candidate, after) : undefined
    const afterIndex = pending.length
    if (newBytes) pending.push({ bytes: newBytes, mediaType: 'application/octet-stream' })
    const oldText = oldBytes ? evidenceText(oldBytes) : '', newText = newBytes ? evidenceText(newBytes) : ''
    const status: ChangeDiff['status'] = before && !beforeRef ? 'unavailable-base'
      : before && after && before.kind !== after.kind ? 'type-change'
      : oldText === undefined || newText === undefined ? 'binary' : 'text'
    const patchIndex = pending.length
    if (status === 'text') pending.push({ bytes: Buffer.from(patch(path, before, after, oldText!, newText!)), mediaType: 'text/x-diff' })
    return { path, status, before, beforeRef, after, afterIndex, patchIndex }
  })
  const refs = store.putArtifacts(taskId, pending)
  const diffs: ChangeDiff[] = prepared.map(item => ({ path: item.path, status: item.status,
    ...(item.before ? { before: { entry: item.before, ...(item.beforeRef ? { content: item.beforeRef } : {}) } } : {}),
    ...(item.after ? { after: { entry: item.after, content: refs[item.afterIndex] } } : {}),
    ...(item.status === 'text' ? { patch: refs[item.patchIndex] } : {}) }))
  return store.putArtifact(taskId, Buffer.from(JSON.stringify({ schemaVersion: 2, base: base.id, changes, diffs, candidate })), 'application/vnd.dsh-fusion.change-manifest+json')
}
