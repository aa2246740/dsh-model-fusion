import { readFileSync } from 'node:fs'
import type { ExplorationReport, ExplorationSource, WorkOrder } from '../contracts.js'
import { sha256Hex } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { workspacePath } from './workspace.js'
import type { WorkspaceSnapshot } from './workspace.js'

/** Bounded, source-backed handoff. No commands, guessed snippets or verification claims. */
export function captureExploration(store: SqliteFusionStore, order: WorkOrder, snapshot: WorkspaceSnapshot,
  submitted: Pick<ExplorationReport, 'summary' | 'status' | 'unresolved'>, sources: readonly ExplorationSource[]): ExplorationReport {
  if (order.mode !== 'explore' || order.baseSnapshot !== snapshot.id) throw new Error('Exploration workspace changed; inspect and explore again')
  if (sources.length > 12 || submitted.status === 'completed' && !sources.length) throw new Error('A completed exploration requires 1–12 source ranges')
  let total = 0
  const captured = sources.map(source => {
    const path = workspacePath(snapshot.root, source.path)
    const entry = snapshot.entries.find(entry => entry.path === source.path && entry.kind === 'file')
    if (!entry) throw new Error('Exploration sources must be files in the frozen workspace manifest')
    if (!Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)
      || source.startLine < 1 || source.endLine < source.startLine || source.endLine - source.startLine >= 80) {
      throw new Error('Exploration source ranges require 1–80 lines each')
    }
    const bytes = readFileSync(path)
    if (sha256Hex(bytes) !== entry.digest) throw new Error('Exploration source changed during capture')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Exploration sources must be text files')
    const lines = content.split('\n')
    if (source.endLine > lines.length) throw new Error('Exploration source range exceeds the file')
    const text = lines.slice(source.startLine - 1, source.endLine).join('\n')
    total += Buffer.byteLength(text, 'utf8')
    if (total > 24_000) throw new Error('Exploration excerpts exceed 24000 bytes; select narrower ranges')
    return { ...source, fileDigest: entry.digest,
      excerpt: store.putArtifact(order.taskId, Buffer.from(text), 'text/plain') }
  })
  return { schemaVersion: 1, workOrderId: order.id, revision: order.revision,
    ...submitted, snapshot: snapshot.id, sources: captured }
}
