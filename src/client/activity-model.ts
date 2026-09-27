import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FusionActivity } from '../activity.js'
import { activityCallId } from '../activity.js'

export interface ActivityRow {
  id: string
  call: Extract<FusionActivity['source'], { type: 'tool/call' }>
  result?: Extract<FusionActivity['source'], { type: 'tool/result' }>
}

export function activityRows(events: readonly FusionActivity[]): ActivityRow[] {
  const rows = new Map<string, ActivityRow>()
  for (const event of events) {
    const id = activityCallId(event)
    if (event.source.type === 'tool/call') rows.set(id, { id, call: event.source })
    else {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, result: event.source })
    }
  }
  return [...rows.values()]
}

/** Only actual result-time metadata is labelled an applied diff. */
export function activityDiffs(row: ActivityRow): DiffHunk[] {
  if (!row.result || row.result.data.message.isError) return []
  const meta = row.result.data.meta as { diffs?: unknown } | undefined
  if (!Array.isArray(meta?.diffs)) return []
  return meta.diffs.filter((hunk): hunk is DiffHunk => hunk && typeof hunk === 'object'
    && typeof hunk.path === 'string' && (typeof hunk.oldText === 'string' || hunk.oldText === null) && typeof hunk.newText === 'string')
}
