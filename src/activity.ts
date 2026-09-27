import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools/types'

/** Plugin-owned presentation record; never appended to a native Session. */
export interface FusionActivity {
  schemaVersion: 1
  taskId: string
  childSessionId: string
  parentCallId: string
  turn: number
  step: number
  anchorSeq: number
  source: SessionEvent<'tool/call'> | SessionEvent<'tool/result'>
}

/** Namespaced display identity; the unchanged native identity remains in source. */
export function activityCallId(activity: FusionActivity): string {
  const event = activity.source
  const id = event.type === 'tool/call' ? event.data.callId : event.data.message.source.callId
  return `fusion:${activity.childSessionId}:${id}`
}

export interface FusionActivityPage { events: FusionActivity[]; cursor: number; more: boolean; done: boolean }
