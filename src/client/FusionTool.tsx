import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useEffect, useMemo, useState } from 'react'
import type { FusionActivity, FusionActivityPage } from '../activity.js'
import { activityRows } from './activity-model.js'
import { tr, useLang } from './i18n.js'
import { ActivityCard, activityStyles } from './ActivityRows.js'

export const fusionControlTools = ['fusion_read_state', 'fusion_delegate_text', 'fusion_explore', 'fusion_delegate', 'fusion_rework', 'fusion_wait', 'fusion_review_result',
  'fusion_submit_result', 'fusion_takeover', 'fusion_finish_direct', 'fusion_read_evidence'] as const

/** Keep internal coordination out of the normal conversation. Errors remain visible. */
export function FusionTool({ block, sessionId, callId, toolName, cwd, openFile }: ToolCallViewProps) {
  const lang = useLang()
  const settled = 'kind' in block
  const tracksActivity = toolName === 'fusion_delegate_text' || toolName === 'fusion_explore' || toolName === 'fusion_delegate' || toolName === 'fusion_rework'
  const [snapshot, setSnapshot] = useState<{ key: string; events: FusionActivity[]; done: boolean; failed?: boolean }>()
  const key = `${sessionId}:${callId}`
  useEffect(() => {
    if (!tracksActivity) return
    let active = true, busy = false, cursor = -1, timer: ReturnType<typeof setTimeout> | undefined
    const events = new Map<number, FusionActivity>()
    let abort: AbortController | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const refresh = async () => {
      if (!active || busy || !visible()) return
      busy = true; abort = new AbortController()
      const deadline = setTimeout(() => abort?.abort(), 10000)
      let again = true, delay = 2000
      try {
        const response = await fetch(`/api/model-fusion?view=activity&sessionId=${encodeURIComponent(sessionId)}&callId=${encodeURIComponent(callId)}&after=${cursor}`,
          { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('Activity unavailable')
        const page = await response.json() as FusionActivityPage
        if (!Array.isArray(page.events) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor) throw new Error('Invalid activity page')
        for (const event of page.events) if (event.parentCallId === callId) events.set(event.source.seq, event)
        cursor = page.cursor; again = page.more || !page.done || !settled; delay = page.more ? 0 : 2000
        if (active) setSnapshot({ key, events: [...events.values()].sort((a, b) => a.source.seq - b.source.seq), done: page.done })
      } catch {
        if (active) setSnapshot(previous => ({ key, events: previous?.key === key ? previous.events : [], done: false, failed: true }))
      } finally {
        clearTimeout(deadline); busy = false
        if (active && again && visible()) timer = setTimeout(() => { void refresh() }, delay)
      }
    }
    const visibility = () => { if (timer) clearTimeout(timer); if (document.visibilityState === 'hidden') abort?.abort(); else void refresh() }
    void refresh(); document.addEventListener('visibilitychange', visibility)
    return () => { active = false; abort?.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [sessionId, callId, key, tracksActivity, settled])
  const current = tracksActivity && snapshot?.key === key ? snapshot : undefined
  const rows = useMemo(() => activityRows(current?.events ?? []), [current?.events])
  const text = settled ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
  let problem = settled && block.isError ? text : ''
  if (!problem) {
    try {
      const result = JSON.parse(text) as { status?: string; reason?: string }
      if (result.status === 'needs-decision') problem = result.reason ?? tr(lang, '任务需要进一步处理。', 'The task needs attention.')
    } catch { /* Non-JSON successful evidence carries no user action. */ }
  }
  return <>
    {rows.length > 0 && <style>{activityStyles}</style>}
    {rows.map(row => <ActivityCard key={row.id} row={row} done={current?.done ?? false} cwd={cwd} openFile={openFile} />)}
    {current?.failed && <p role="status">{tr(lang, '执行记录暂时无法加载，正在重试。', 'Activity is unavailable; retrying.')}</p>}
    {problem && <p role="status" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{problem}</p>}
  </>
}
