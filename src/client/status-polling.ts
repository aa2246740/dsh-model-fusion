import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { FusionStatus } from '../status.js'

interface Snapshot { sessionId: string; status?: FusionStatus; failed: boolean }
interface Entry {
  snapshot?: Snapshot
  listeners: Map<() => void, () => boolean>
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
  abort?: AbortController
  visibility: () => void
}
const entries = new Map<string, Entry>()
const visible = () => document.visibilityState !== 'hidden'
const running = new Set(['分析', '执行', '修改', '审查', '验证', '正在停止'])

function subscribe(sessionId: string, listener: () => void, expanded: () => boolean): () => void {
  let entry = entries.get(sessionId)
  if (!entry) {
    entry = { listeners: new Map(), busy: false, visibility: () => {} }
    entries.set(sessionId, entry)
    const own = entry
    const active = () => entries.get(sessionId) === own && own.listeners.size > 0
    const publish = (snapshot: Snapshot) => {
      if (!active()) return
      own.snapshot = snapshot
      for (const notify of own.listeners.keys()) notify()
    }
    const refresh = async () => {
      if (!active() || own.busy || !visible()) return
      clearTimeout(own.timer)
      own.busy = true
      const abort = new AbortController(); own.abort = abort
      const deadline = setTimeout(() => {
        if (active() && visible()) publish({ sessionId, failed: true })
        abort.abort()
      }, 10000)
      try {
        const response = await fetch(`/api/model-fusion?view=status&sessionId=${encodeURIComponent(sessionId)}`,
          { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('unavailable')
        const status = await response.json() as FusionStatus
        if (status.schemaVersion !== 1 || status.sessionId !== sessionId) throw new Error('mismatched status')
        if (!abort.signal.aborted) publish({ sessionId, status, failed: false })
      } catch {
        if (!abort.signal.aborted) publish({ sessionId, failed: true })
      } finally {
        clearTimeout(deadline); own.busy = false
        if (active() && visible()) {
          const fast = [...own.listeners.values()].some(value => value()) && running.has(own.snapshot?.status?.task?.stage ?? '')
          own.timer = setTimeout(() => { void refresh() }, fast ? 2000 : 15000)
        }
      }
    }
    own.visibility = () => {
      clearTimeout(own.timer)
      if (!visible()) own.abort?.abort()
      else void refresh()
    }
    document.addEventListener('visibilitychange', own.visibility)
  }
  entry.listeners.set(listener, expanded)
  if (entry.listeners.size === 1 || expanded()) entry.visibility()
  const own = entry
  return () => {
    own.listeners.delete(listener)
    if (own.listeners.size) return
    entries.delete(sessionId)
    clearTimeout(own.timer); own.abort?.abort()
    document.removeEventListener('visibilitychange', own.visibility)
  }
}

/** One in-flight read per mounted session; collapsed hints still discover new attention states. */
export function useFusionStatus(sessionId: string, expandedTask: string | undefined, attentionOnly = false): Snapshot | undefined {
  const expandedRef = useRef(expandedTask), attentionRef = useRef(attentionOnly)
  expandedRef.current = expandedTask; attentionRef.current = attentionOnly
  useEffect(() => { if (expandedTask) entries.get(sessionId)?.visibility() }, [sessionId, expandedTask])
  return useSyncExternalStore(
    useCallback(listener => subscribe(sessionId, listener, () => {
      const task = entries.get(sessionId)?.snapshot?.status?.task
      return expandedRef.current !== undefined && task?.id === expandedRef.current && (!attentionRef.current || task.attention)
    }), [sessionId]),
    useCallback(() => entries.get(sessionId)?.snapshot, [sessionId]),
    () => undefined,
  )
}
