import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ArtifactRef, TaskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { SessionBinding } from './bindings.js'

interface NoticeProjection {
  schemaVersion: 1
  taskId: TaskId
  parentId: string
  childId: string
  originalMessageId: string
  originalDigest: string
  artifact: ArtifactRef
  message: UserMessage
}

/** Reduce only our Worker's runtime closing notice, never its structured report. */
export class NativeWorkerNotices {
  constructor(readonly store: SqliteFusionStore) {}

  project(agent: Agent, binding: SessionBinding, original: UserMessage): UserMessage {
    const source = original.source
    if (agent.id !== binding.sessionId || source?.kind !== 'subagent-settled') return original
    const child = this.store.readDocument(`child:${source.senderSessionId}`)?.value as { parent?: string; taskId?: TaskId } | undefined
    const task = child?.taskId && this.store.load(child.taskId)
    if (child?.parent !== agent.id || !task || task.parent !== String(agent.id)
      || (task.acceptedChild !== String(source.senderSessionId) && task.reservedChild !== String(source.senderSessionId))) return original

    const originalDigest = digestOf(original)
    const id = `worker-notice:${binding.taskId}:${digestOf({ parent: agent.id, message: original.id })}`
    const saved = this.store.readDocument(id)?.value as NoticeProjection | undefined
    if (saved) {
      if (saved.schemaVersion !== 1 || saved.taskId !== binding.taskId || saved.parentId !== agent.id
        || saved.childId !== source.senderSessionId || saved.originalDigest !== originalDigest) {
        throw new Error('Fusion Worker notice identity requires reconciliation')
      }
      this.store.readArtifact(binding.taskId, saved.artifact.id)
      return saved.message
    }
    // Keep the entire original, including failure detail and closing blocks,
    // available through owned evidence. This projection claims no task success.
    const artifact = this.store.putArtifact(binding.taskId, Buffer.from(JSON.stringify(original)), 'application/vnd.dsh-fusion.worker-notice+json')
    const message = createUserMessage({ source: { kind: 'plugin:dsh-model-fusion', form: 'notice', summary: source.summary },
      content: [{ type: 'text', text: `${source.summary}\nThis is a Worker activation notice, not task acceptance. Use the structured Fusion report and check evidence; use fusion_wait if they have not been collected. Closing transcript is archived rather than repeated here. For missing failure details use fusion_read_evidence with id ${artifact.id}.\n${JSON.stringify({ childId: source.senderSessionId, originalMessageId: original.id, artifact })}` }] })
    this.store.writeDocument(id, 0, { schemaVersion: 1, taskId: binding.taskId, parentId: agent.id,
      childId: source.senderSessionId, originalMessageId: original.id, originalDigest, artifact, message } satisfies NoticeProjection)
    return message
  }

  /** Replace retained legacy notices before the native compactor reads history.
   * Public surface replacement preserves the original append-only event and
   * cites it. Already compacted prose cannot be safely reverse-transformed.
   */
  projectHistory(agent: Agent, binding: SessionBinding): void {
    for (const seq of [...agent.session.surface.nodes]) {
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const message = this.project(agent, binding, event.data)
      if (message === event.data) continue
      agent.session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      })
    }
  }
}
