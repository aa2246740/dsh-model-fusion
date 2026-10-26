import { readFileSync } from 'node:fs'
import type { ExplorationReport, ExplorationSource, WorkOrder } from '../contracts.js'
import { sha256Hex } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { changedPaths, workspacePath } from './workspace.js'
import type { WorkspaceSnapshot } from './workspace.js'

interface PreparedSource { source: ExplorationSource; text: string; digest: string }

function formatChanged(paths: readonly string[]): string {
  const shown = paths.slice(0, 12)
  if (!shown.length) return '(snapshot id changed with no listed path delta)'
  return `${shown.join(', ')}${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''}`
}

/** Read cited ranges against the frozen baseline. Nothing is stored until every range is valid. */
function prepareSources(baseline: WorkspaceSnapshot, sources: readonly ExplorationSource[]): PreparedSource[] {
  if (sources.length > 12) throw new Error('A completed exploration requires 1–12 source ranges')
  let total = 0
  return sources.map(source => {
    const path = workspacePath(baseline.root, source.path)
    const entry = baseline.entries.find(item => item.path === source.path && item.kind === 'file')
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
    return { source, text, digest: entry.digest }
  })
}

function storeSources(store: SqliteFusionStore, taskId: WorkOrder['taskId'], prepared: readonly PreparedSource[]): ExplorationReport['sources'] {
  return prepared.map(item => ({ ...item.source, fileDigest: item.digest,
    excerpt: store.putArtifact(taskId, Buffer.from(item.text), 'text/plain') }))
}

/**
 * Source-backed handoff. Completed reports are checked against the files they cite,
 * not against every other file in a non-git root. blocked and needs-decision reports
 * are always recorded, with the drift named, and are not acceptance.
 */
export function captureExploration(store: SqliteFusionStore, order: WorkOrder, baseline: WorkspaceSnapshot, current: WorkspaceSnapshot,
  submitted: Pick<ExplorationReport, 'summary' | 'status' | 'unresolved'>, sources: readonly ExplorationSource[]): ExplorationReport {
  if (order.mode !== 'explore' || baseline.id !== order.baseSnapshot || baseline.root !== current.root) {
    throw new Error('Exploration capture requires the frozen explore baseline')
  }
  const drifted = baseline.id !== current.id
  const changed = drifted ? changedPaths(baseline, current) : []
  const driftDetail = drifted
    ? `Exploration workspace changed since frozen baseline ${baseline.id}; current snapshot ${current.id}; changed paths: ${formatChanged(changed)}. This is not acceptance. A completed report can cite only files that still match the baseline; blocked or needs-decision records this drift.`
    : undefined
  if (submitted.status !== 'completed') {
    const problems = driftDetail ? [driftDetail] : []
    let prepared: PreparedSource[] = []
    if (sources.length) {
      try { prepared = prepareSources(baseline, sources) }
      catch (error) { problems.push(error instanceof Error ? error.message : String(error)) }
    }
    return { schemaVersion: 1, workOrderId: order.id, revision: order.revision, summary: submitted.summary,
      status: submitted.status, unresolved: [...submitted.unresolved, ...problems], snapshot: baseline.id,
      sources: storeSources(store, order.taskId, prepared) }
  }
  if (!sources.length || sources.length > 12) throw new Error('A completed exploration requires 1–12 source ranges')
  if (drifted) {
    const cited = new Set(sources.map(source => source.path))
    const citedChanged = changed.filter(path => cited.has(path))
    if (citedChanged.length) {
      throw new Error(`Cited exploration evidence changed: ${citedChanged.join(', ')}. Frozen baseline ${baseline.id}; current snapshot ${current.id}. Submit status "blocked" or "needs-decision" to record this drift; a completed report cannot cite files that no longer match the frozen baseline.`)
    }
  }
  const prepared = prepareSources(baseline, sources)
  return { schemaVersion: 1, workOrderId: order.id, revision: order.revision, ...submitted,
    snapshot: baseline.id, sources: storeSources(store, order.taskId, prepared) }
}

/** Path of the first cited file whose bytes no longer match the captured digest, if any. */
export function citedEvidenceChanged(root: string, baseline: WorkspaceSnapshot, report: Pick<ExplorationReport, 'sources'>): string | undefined {
  for (const source of report.sources) {
    const entry = baseline.entries.find(item => item.path === source.path && item.kind === 'file')
    if (!entry || entry.digest !== source.fileDigest) return source.path
    try {
      const bytes = readFileSync(workspacePath(root, source.path))
      if (sha256Hex(bytes) !== source.fileDigest) return source.path
    } catch { return source.path }
  }
  return undefined
}
