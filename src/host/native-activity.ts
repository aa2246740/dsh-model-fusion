import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { FusionActivity, FusionActivityPage } from '../activity.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'

interface ActivityLink {
  parentId: string
  childId: string
  taskId: string
  callId: string
  turn: number
  step: number
  anchorSeq: number
  fromSeq: number | null
  done?: boolean
}
const prefix = 'activity-link:'
const visibleTools = new Set(['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_kill', 'str_replace_editor'])
const parentPrefix = (parentId: string) => `activity:${encodeURIComponent(parentId)}:`
const callPrefix = (parentId: string, callId: string) => `${parentPrefix(parentId)}${encodeURIComponent(callId)}:`

/** Paginated read-only data for a plugin-owned tool view; no runtime activation. */
export function readFusionActivity(store: SqliteFusionStore, parentId: string, callId: string, after = -1): FusionActivityPage {
  if (!Number.isSafeInteger(after) || after < -1) throw new Error('Invalid activity cursor')
  const rows = store.listDocumentIds(callPrefix(parentId, callId)).map(id => store.readDocument(id)!.value as FusionActivity)
    .filter(row => row.source.seq > after).sort((a, b) => a.source.seq - b.source.seq)
  const events = rows.slice(0, 100)
  const links = store.listDocumentIds(prefix).map(id => store.readDocument(id)!.value as ActivityLink)
  const link = links.find(row => row.parentId === parentId && row.callId === callId)
  return { events, cursor: events.at(-1)?.source.seq ?? after, more: rows.length > events.length, done: !link || link.done === true }
}

/** Old conversations remain readable through the public, non-activating history
 * API. Correlate accepted message ids, never timing guesses or model narration.
 * This fallback neither rewrites the old log nor creates a replacement Worker.
 */
export async function readHistoricalFusionActivity(ctx: Context, store: SqliteFusionStore,
  parentId: string, callId: string, after = -1): Promise<FusionActivityPage> {
  const cached = readFusionActivity(store, parentId, callId, after)
  const linked = store.listDocumentIds(prefix).some(id => {
    const row = store.readDocument(id)!.value as ActivityLink
    return row.parentId === parentId && row.callId === callId
  })
  if (linked || !parentId || !callId) return cached
  const tasks = store.listTaskIds().map(id => store.load(id)!).filter(task => task.parent === parentId)
  for (const task of tasks) {
    if (!task.acceptedChild) continue
    const history = store.events(task.taskId)
    const prepared = history.find(event => event.type === 'work-order/prepared' && event.causeId === callId)
    const delivery = store.listDocumentIds(`worker-delivery:${task.taskId}:`).map(id => store.readDocument(id)!.value as
      { causeId: string; messageId?: string; state: string }).find(row => row.causeId === callId && row.state === 'accepted')
    const accepted = prepared && history.find(event => event.type === 'child/accepted' && event.seq > prepared.seq)
    const messageId = delivery?.messageId ?? (accepted?.type === 'child/accepted' ? accepted.payload.messageId : undefined)
    if (!messageId) continue
    const [parent, child] = await Promise.all([ctx.sessionQuery.readSession(SessionId(parentId)), ctx.sessionQuery.readSession(SessionId(task.acceptedChild))])
    if (child.session.parentSession !== parentId) throw new Error('Fusion activity child ownership mismatch')
    const call = parent.events.find(event => event.type === 'tool/call' && event.data.callId === callId)
    if (!call || call.type !== 'tool/call' || !['fusion_explore', 'fusion_delegate', 'fusion_rework'].includes(call.data.name)) return cached
    const start = child.events.find(event => event.type === 'user/message' && event.data.id === messageId)
    if (!start) return cached
    const acceptedIds = new Set(tasks.flatMap(item => store.events(item.taskId).flatMap(event =>
      event.type === 'child/accepted' && event.payload.child === task.acceptedChild ? [event.payload.messageId] : [])))
    const end = child.events.find(event => event.seq > start.seq && event.type === 'user/message' && acceptedIds.has(event.data.id))?.seq ?? Infinity
    const calls = new Set<string>()
    const all: FusionActivity[] = []
    for (const source of child.events) {
      if (source.seq <= start.seq) continue
      if (source.type === 'tool/call' && source.seq < end && visibleTools.has(source.data.name)) calls.add(source.data.callId)
      else if (source.type !== 'tool/result' || !calls.has(source.data.message.source.callId)) continue
      if (source.type !== 'tool/call' && source.type !== 'tool/result') continue
      all.push({ schemaVersion: 1, taskId: task.taskId, childSessionId: task.acceptedChild, parentCallId: callId,
        turn: call.data.turn, step: call.data.step, anchorSeq: call.seq, source })
    }
    const remaining = all.filter(event => event.source.seq > after), events = remaining.slice(0, 100)
    return { events, cursor: events.at(-1)?.source.seq ?? after, more: remaining.length > events.length,
      done: task.control.mode === 'completed' || child.events.at(-1)?.type === 'turn/end' }
  }
  return cached
}

/** Copies actual Worker tool events into plugin-owned presentation storage only.
 * Model history still contains solely the Lead's native messages and reports.
 * Stored source coordinates make replay/HMR idempotent without executing tools.
 */
export class NativeFusionActivity {
  readonly #dispose: (() => void)[] = []
  #pending: Promise<void> = Promise.resolve()
  readonly #seen = new WeakMap<Session, Set<string>>()
  readonly #calls = new WeakMap<Session, Map<string, FusionActivity>>()
  readonly errors = new Map<string, string>()

  constructor(readonly ctx: Context, readonly store: SqliteFusionStore) {
    this.#dispose.push(ctx.on('session/event', (session, event) => {
      if (!session.header.parentSession) return
      if (event.type === 'turn/end') { this.#enqueue(() => this.#ended(session)); return }
      if (event.type !== 'tool/call' && event.type !== 'tool/result') return
      this.#enqueue(() => this.#mirror(session, event, false))
    }))
    this.#dispose.push(ctx.on('agent/created', ({ agent }) => {
      this.#replay(agent.session)
      for (const child of ctx.sessions.list()) if (child.header.parentSession === agent.id) this.#replay(child)
      return undefined
    }))
    for (const session of ctx.sessions.list()) this.#replay(session)
  }

  /** Called before each native delivery. No inference, dispatch or approval. */
  link(parent: Session, childId: string, taskId: string, callId: string): void {
    const call = parent.snapshotEvents().find(event => event.type === 'tool/call' && event.data.callId === callId)
    if (!call || call.type !== 'tool/call') return // Direct programmatic control has no native UI call to own a row.
    const id = `${prefix}${childId}:${call.seq}`
    if (this.store.readDocument(id)) return
    this.store.writeDocument(id, 0, {
      parentId: parent.id, childId, taskId, callId, turn: call.data.turn, step: call.data.step,
      anchorSeq: call.seq, fromSeq: this.ctx.sessions.get(SessionId(childId))?.seq ?? null,
    } satisfies ActivityLink)
  }

  #enqueue(action: () => void): void {
    // Session.append forbids reentry from event observers, including same-session
    // parent callbacks. Awaited microtasks run after the native append boundary.
    this.#pending = this.#pending.then(action).catch(error => {
      this.errors.set('presentation', String(error))
      this.ctx.logger.warn('Fusion activity presentation failed: %s', String(error))
    })
  }

  #replay(session: Session): void {
    if (!session.header.parentSession) return
    this.#enqueue(() => {
      for (const event of session.snapshotEvents()) {
        if (event.type === 'tool/call' || event.type === 'tool/result') this.#mirror(session, event, true)
        if (event.type === 'turn/end') this.#ended(session, event.seq, false)
      }
    })
  }

  #ended(child: Session, throughSeq: number = child.seq, live = true): void {
    for (const id of this.store.listDocumentIds(`${prefix}${child.id}:`)) {
      const row = this.store.readDocument(id)!, link = row.value as ActivityLink
      if ((link.fromSeq === null ? live : link.fromSeq <= throughSeq) && !link.done) this.store.writeDocument(id, row.revision, { ...link, done: true })
    }
  }

  #mirror(child: Session, event: SessionEvent<'tool/call'> | SessionEvent<'tool/result'>, replay: boolean): void {
    const parent = child.header.parentSession && this.ctx.sessions.get(child.header.parentSession)
    if (!parent) return
    let seen = this.#seen.get(parent), calls = this.#calls.get(parent)
    if (!seen || !calls) {
      seen = new Set(); calls = new Map()
      for (const id of this.store.listDocumentIds(parentPrefix(parent.id))) {
        const activity = this.store.readDocument(id)!.value as FusionActivity
        seen.add(`${activity.childSessionId}:${activity.source.seq}`)
        if (activity.source.type === 'tool/call') calls.set(`${activity.childSessionId}:${activity.source.data.callId}`, activity)
      }
      this.#seen.set(parent, seen); this.#calls.set(parent, calls)
    }
    const key = `${child.id}:${event.seq}`
    if (seen.has(key)) return
    const sourceCallId = event.type === 'tool/call' ? event.data.callId : event.data.message.source.callId
    const callKey = `${child.id}:${sourceCallId}`
    let origin: Omit<FusionActivity, 'source'> | undefined = calls.get(callKey)
    if (event.type === 'tool/call') {
      if (!visibleTools.has(event.data.name)) return
      const links = this.store.listDocumentIds(`${prefix}${child.id}:`).map(id => ({ id, ...this.store.readDocument(id)! }))
        .filter(row => (row.value as ActivityLink).parentId === parent.id)
        .sort((a, b) => (b.value as ActivityLink).anchorSeq - (a.value as ActivityLink).anchorSeq)
      const row = links.find(row => {
        const link = row.value as ActivityLink
        return link.fromSeq === null ? !replay : event.seq >= link.fromSeq
      })
      if (!row) return // Historical, pre-feature calls are not fabricated.
      let link = row.value as ActivityLink
      if (link.fromSeq === null) {
        link = { ...link, fromSeq: event.seq }
        this.store.writeDocument(row.id, row.revision, link)
      }
      origin = { schemaVersion: 1, taskId: link.taskId, childSessionId: child.id,
        parentCallId: link.callId, turn: link.turn, step: link.step,
        // Place all calls below the owning delivery, in original source order.
        anchorSeq: link.anchorSeq + 0.5 - 0.5 / (event.seq + 2) }
    }
    if (!origin) return // Results never acquire an invented call head.
    const activity = { ...origin, source: event } satisfies FusionActivity
    const id = `${callPrefix(parent.id, origin.parentCallId)}${String(event.seq).padStart(12, '0')}`
    if (!this.store.readDocument(id)) this.store.writeDocument(id, 0, activity)
    seen.add(key)
    if (event.type === 'tool/call') calls.set(callKey, activity)
  }

  async flush(): Promise<void> { await this.#pending }

  async close(): Promise<void> {
    for (const dispose of this.#dispose.splice(0).reverse()) dispose()
    await this.flush()
  }
}
