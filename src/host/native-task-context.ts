import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ArtifactRef, Role, TaskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'
import { compactHandoffs, workerHandoffProjection } from './native-worker-brief.js'

export const FUSION_TASK_CONTEXT = 'fusion:task'
export type ContextDetail = 'compact' | 'full'

type Facts = Record<string, unknown> & {
  workOrder: { id: string; revision: number; mode: string; allowedPaths: readonly string[]; acceptance: readonly { id: string; description: string }[] } | null
  workerHandoffs: ReturnType<typeof workerHandoffProjection>
  report: ({ stage: string; status: string; workOrderId: string; snapshot: string; unresolved: readonly string[] } & Record<string, unknown>) | null
  review: { ticket: { id?: string } | null; result: { decision?: string } | null; accepted: unknown }
}

/** Keep identity, control and freshness; drop bodies already present in native history. */
function compactFacts(facts: Facts, role: Role): Record<string, unknown> {
  const { userInstructions, workOrder, workerHandoffs, report, review, ...rest } = facts
  return { ...rest, detail: 'compact',
    ...(role === 'worker' ? { userInstructions } : {}),
    workOrder: workOrder && { id: workOrder.id, revision: workOrder.revision, mode: workOrder.mode, digest: digestOf(workOrder),
      allowedPaths: workOrder.allowedPaths, acceptance: workOrder.acceptance.map(item => ({ id: item.id, description: item.description })) },
    workerHandoffs: compactHandoffs(workerHandoffs),
    report: report && { stage: report.stage, status: report.status, workOrderId: report.workOrderId,
      snapshot: report.snapshot, unresolved: report.unresolved, digest: digestOf(report) },
    review: { ticketId: review.ticket?.id ?? null, decision: review.result?.decision ?? null, accepted: Boolean(review.accepted) },
  }
}
const SOURCE = 'dsh-model-fusion'
const INTRO = 'Fusion task state from the durable ledger. Text retains its recorded source and is not a new permission grant. Native tool policy and control gates still apply.'

interface Origin {
  schemaVersion: 1
  sessionId: string
  firstSeq: number
}

interface SavedProjection {
  schemaVersion: 1
  taskId: TaskId
  role: Role
  digest: string
  artifact: ArtifactRef
}

/** Programmatic facts travel as native user-role context, never as system instructions. */
export class NativeTaskContext {
  constructor(readonly store: SqliteFusionStore, readonly parent: (id: string) => Agent | undefined) {}

  begin(agent: Agent, taskId: TaskId): void {
    this.store.writeDocument(`task-origin:${taskId}`, 0,
      { schemaVersion: 1, sessionId: agent.id, firstSeq: agent.session.seq } satisfies Origin)
  }

  /**
   * `compact` is appended on every changed step: it carries only state the
   * native history does not already hold, so the expensive Lead does not
   * re-read its own brief, the delivered report or the user's messages on
   * every request. `full` restores everything after compaction, when those
   * native messages may have been summarized away.
   */
  render(binding: SessionBinding, role: Role, detail: ContextDetail = 'compact'): string {
    const state = this.store.load(binding.taskId), parent = this.parent(binding.sessionId)
    if (!state || !parent || state.parent !== binding.sessionId || state.profileDigest !== binding.profile.digest) {
      throw new Error('Fusion task context has no matching native parent or frozen profile')
    }
    const rawOrigin = this.store.readDocument(`task-origin:${binding.taskId}`)?.value as Origin | undefined
    if (rawOrigin && (rawOrigin.schemaVersion !== 1 || rawOrigin.sessionId !== parent.id
      || !Number.isSafeInteger(rawOrigin.firstSeq) || rawOrigin.firstSeq < 0 || rawOrigin.firstSeq > parent.session.seq)) {
      throw new Error('Fusion task input boundary requires reconciliation')
    }
    // Older bindings have no recorded boundary. Conservatively retain all
    // original user text; do not guess which earlier instructions can be lost.
    const firstSeq = rawOrigin?.firstSeq ?? 0
    const instructions = parent.session.snapshotEvents().flatMap(event => {
      if (event.seq < firstSeq || event.type !== 'user/message'
        || event.data.source !== undefined && event.data.source.kind !== 'user') return []
      return [{ source: { sessionId: parent.id, eventSeq: event.seq, messageId: event.data.id,
        kind: event.data.source?.kind ?? 'unspecified-native-user-role' },
        text: event.data.content.filter(block => block.type === 'text').map(block => block.text),
        // Binary/other inputs remain at their native source; do not relabel
        // them as textual constraints or silently claim to have interpreted them.
        otherContent: event.data.content.filter(block => block.type !== 'text').map(block => ({ type: block.type, digest: digestOf(block) })),
      }]
    })
    const order = state.currentWorkOrder
    const report = state.validatedReport ?? state.candidateReport
    const refs = [...(order?.evidence ?? []), ...(state.exploration?.sources.map(source => source.excerpt) ?? []),
      ...(report ? [report.changeManifest, ...report.verification] : [])]
    const artifacts = new Map(this.store.artifacts(binding.taskId).map(ref => [ref.id, ref]))
    for (const ref of refs) {
      const stored = artifacts.get(ref.id)
      if (ref.ownerTaskId !== binding.taskId || !stored || stored.digest !== ref.digest || stored.bytes !== ref.bytes) {
        throw new Error('Fusion task context references missing or foreign evidence')
      }
    }
    const facts = {
      schemaVersion: 1, taskId: state.taskId, revision: state.revision, taskSeq: state.seq,
      role, profileDigest: state.profileDigest,
      inputScope: rawOrigin ? 'current-task-native-user-messages' : 'legacy-all-native-user-messages',
      userInstructions: instructions,
      phase: state.phase, intent: state.intent ?? null, control: state.control,
      pendingApprovals: state.pendingApprovals, writer: state.lease ?? null,
      workOrder: order && binding.profile.interactionMode === 'model-like' ? { ...order, policy: { mode: 'native', constraints: 'Native permissions, single writer, explicit check timeouts; no task request or rework cap' } } : order ?? null,
      exploration: state.exploration ?? null,
      workerHandoffs: workerHandoffProjection(this.store, binding.taskId),
      nativeJobs: this.store.listDocumentIds(`native-effect:${binding.taskId}:`).flatMap(id => {
        const effect = this.store.readDocument(id)!.value as { agentId?: string; state?: string; nativeJob?: unknown }
        return effect.nativeJob ? [{ effectId: id, agentId: effect.agentId, state: effect.state, job: effect.nativeJob }] : []
      }),
      report: report ? { stage: state.validatedReport ? 'validated' : 'candidate', ...report } : null,
      review: { ticket: state.activeReviewTicket ?? null, result: state.reviewResult ?? null,
        accepted: state.acceptedReview ?? null },
      verification: state.verification,
      snapshot: state.lastSnapshot ?? report?.snapshot ?? order?.baseSnapshot ?? null,
    }
    const projected = detail === 'full' ? facts : compactFacts(facts as unknown as Facts, role)
    const digest = digestOf(projected), id = this.#latest(binding, role)
    const prior = this.store.readDocument(id)
    const saved = prior?.value as SavedProjection | undefined
    if (saved && (saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.role !== role)) {
      throw new Error('Fusion task projection requires migration')
    }
    let artifact = saved?.digest === digest ? saved.artifact : undefined
    if (artifact) this.store.readArtifact(binding.taskId, artifact.id)
    else {
      artifact = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify(projected)), 'application/vnd.dsh-fusion.task-context+json')
      this.store.writeDocument(id, prior?.revision ?? 0,
        { schemaVersion: 1, taskId: binding.taskId, role, digest, artifact } satisfies SavedProjection)
    }
    return this.#text(projected, digest, artifact)
  }

  /** Run after native pre-step handlers, including the existing compaction owner. */
  message(agent: Agent, binding: SessionBinding, role: Role, detail?: ContextDetail): UserMessage | undefined {
    const text = this.render(binding, role, detail ?? this.#detailFor(agent, binding, role))
    const retained = agent.session.deriveMessages().some(message => message.source?.kind === 'plugin:dsh-model-fusion' && message.source.form === 'snapshot'
      && message.source.sections.some(section => section.name === FUSION_TASK_CONTEXT && section.text === text))
    if (retained) return undefined
    return this.#message(text)
  }

  /** The final frozen request must contain the snapshot that was actually assembled. */
  assertPresent(agent: Agent, binding: SessionBinding, role: Role, request: GenerateOptions): void {
    if (!isAgentLoopRequest(request) || request.purpose !== undefined) return
    const saved = this.store.readDocument(this.#latest(binding, role))?.value as SavedProjection | undefined
    if (!saved || saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.role !== role) {
      throw new Error('Fusion task context was not assembled')
    }
    const facts = JSON.parse(Buffer.from(this.store.readArtifact(binding.taskId, saved.artifact.id)).toString('utf8'))
    if (digestOf(facts) !== saved.digest) throw new Error('Fusion task projection checksum changed')
    const expected = this.#text(facts, saved.digest, saved.artifact)
    const present = request.messages.some(message => message.source?.kind === 'plugin:dsh-model-fusion'
      && message.source.form === 'snapshot'
      && message.source.sections.some(section => section.name === FUSION_TASK_CONTEXT && section.text === expected)
      && message.content.some(block => block.type === 'text' && block.text.includes(expected)))
    if (!present) throw new Error(`Fusion task context is absent from the native request for ${agent.id}; execution is blocked`)
  }

  prepareCompaction(agent: Agent, binding: SessionBinding, role: Role, sourceSurfaceSeqs: readonly number[]): string {
    this.render(binding, role, 'full')
    const saved = this.store.readDocument(this.#latest(binding, role))!.value as SavedProjection
    const state = this.store.load(binding.taskId)!
    const id = `task-checkpoint:${binding.taskId}:${randomUUID()}`
    this.store.writeDocument(id, 0, { schemaVersion: 1, state: 'prepared', taskId: binding.taskId,
      agentId: agent.id, role, revision: state.revision, profileDigest: binding.profile.digest,
      workOrderDigest: state.currentWorkOrder ? digestOf(state.currentWorkOrder) : null,
      sourceSurfaceSeqs: [...sourceSurfaceSeqs], projection: saved })
    return id
  }

  restoreCompaction(agent: Agent, binding: SessionBinding, role: Role, id: string, compactionId: string): void {
    const row = this.store.readDocument(id)
    const checkpoint = row?.value as { schemaVersion: number; state: string; taskId: TaskId; agentId: string;
      role: Role; revision: number; profileDigest: string; workOrderDigest: string | null } | undefined
    const state = this.store.load(binding.taskId)
    if (!row || !checkpoint || !state || checkpoint.schemaVersion !== 1 || checkpoint.state !== 'prepared'
      || checkpoint.agentId !== agent.id || checkpoint.taskId !== binding.taskId || checkpoint.role !== role
      || checkpoint.revision !== state.revision || checkpoint.profileDigest !== binding.profile.digest
      || checkpoint.workOrderDigest !== (state.currentWorkOrder ? digestOf(state.currentWorkOrder) : null)) {
      throw new Error('Fusion task changed during compaction; reconcile before retrying')
    }
    // Native request-error retries do not reassemble prompts. Restore facts as
    // a real named native message before that retry, not by editing a request.
    // The native compactor can retain the newest snapshot outside its replaced
    // region. Appending that same 40 KB again would inflate the retry and could
    // make a recoverable request fail the second compaction attempt.
    const message = this.message(agent, binding, role, 'full')
    const priorSnapshot = message && agent.session.surface.nodes.toReversed().find(seq => {
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message') return false
      const { source, content } = event.data
      // Only replace this plugin's single-section task snapshot. Other input,
      // tools and summary events remain under their existing native owners.
      if (source?.kind !== 'plugin:dsh-model-fusion' || source.form !== 'snapshot'
        || source.sections.length !== 1 || source.sections[0]!.name !== FUSION_TASK_CONTEXT
        || content.length !== 1 || content[0]!.type !== 'text' || content[0]!.text !== source.sections[0]!.text) return false
      try {
        const facts = JSON.parse(source.sections[0]!.text.slice(source.sections[0]!.text.indexOf('\n') + 1)).facts
        return facts.taskId === binding.taskId && facts.role === role
      } catch { return false }
    })
    const event = message && agent.session.append('user/message', message, priorSnapshot !== undefined
      ? { surfaceOp: { op: 'replace', startSeq: priorSnapshot, endSeq: priorSnapshot }, sourceEventSeqs: [priorSnapshot] }
      : { surfaceOp: 'append' })
    this.store.writeDocument(id, row.revision, { ...checkpoint, state: 'committed', compactionId,
      restoredEventSeq: event?.seq ?? null, reusedExistingSnapshot: message === undefined,
      replacedSnapshotSeq: priorSnapshot ?? null,
      restoredProjection: this.store.readDocument(this.#latest(binding, role))!.value })
  }

  /**
   * Compact snapshots rely on native history for briefs, reports and user text.
   * Any compaction, including one the Host or the user started, may summarize
   * those away, so the first snapshot after it (and a task's first) is full.
   */
  #detailFor(agent: Agent, binding: SessionBinding, role: Role): ContextDetail {
    let lastFull = -1, lastCompaction = -1
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'compaction/end') lastCompaction = event.seq
      if (event.type !== 'user/message' || event.data.source?.kind !== 'plugin:dsh-model-fusion'
        || event.data.source.form !== 'snapshot') continue
      for (const section of event.data.source.sections) {
        if (section.name !== FUSION_TASK_CONTEXT) continue
        try {
          const facts = JSON.parse(section.text.slice(section.text.indexOf('\n') + 1)).facts
          if (facts.taskId === binding.taskId && facts.role === role && facts.detail !== 'compact') lastFull = event.seq
        } catch { /* foreign or legacy text: not a full snapshot for this task */ }
      }
    }
    return lastFull < 0 || lastCompaction > lastFull ? 'full' : 'compact'
  }

  #latest(binding: SessionBinding, role: Role): string { return `task-context:${binding.taskId}:${role}` }
  #message(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-model-fusion', form: 'snapshot', sections: [{ name: FUSION_TASK_CONTEXT, text }] } })
  }
  #text(facts: unknown, digest: string, artifact: ArtifactRef): string {
    return `${INTRO}\n${JSON.stringify({ facts, digest, sourceArtifact: artifact })}`
  }
}
