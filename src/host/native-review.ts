import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ReviewTicket, TaskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import { captureTicket } from '../review/ticket.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'

/** Capture before the Lead request starts; later tool callbacks cannot bind to a newer report. */
export function captureNativeReviewRequest(store: SqliteFusionStore, agent: Agent, turn: number, step: number, ticket: ReviewTicket): void {
  const id = `review-request:${agent.id}:${turn}:${step}`
  const prior = store.readDocument(id)
  const next = { schemaVersion: 1, sessionId: agent.id, turn, step, ticket: captureTicket(ticket) }
  if (prior) {
    if (digestOf(prior.value) !== digestOf(next)) throw new Error('Native review request was already bound to another ticket')
    return
  }
  store.writeDocument(id, 0, next)
}

export function nativeReviewProof(store: SqliteFusionStore, taskId: TaskId, exec: ToolExecution): {
  ticket: Readonly<ReviewTicket>; terminalEvidenceRef: string; finishReason: 'tool_calls' | 'stop'
} {
  const agent = exec.agent
  if (!agent || exec.signal.aborted) throw new Error('Review requires a live, uncancelled Lead tool execution')
  const events = agent.session.snapshotEvents()
  const message = events.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'tool-call' && block.id === exec.rootCallId))
  if (!message || message.type !== 'assistant/message' || message.data.interrupted) throw new Error('Review has no complete native assistant message')
  const terminals = message.data.stream.filter(record => record.type === 'chunk' && record.chunk.type === 'finish')
  const terminal = terminals.at(-1)
  if (terminals.length !== 1 || terminal?.type !== 'chunk' || terminal.chunk.type !== 'finish'
    || !['stop', 'tool-calls'].includes(terminal.chunk.reason.kind)) throw new Error('Review assistant stream did not terminate successfully')
  const sourceCall = message.data.message.content.find(block => block.type === 'tool-call' && block.id === exec.rootCallId)
  if (!sourceCall || sourceCall.type !== 'tool-call') throw new Error('Native review tool call missing')
  if (!exec.parent && (sourceCall.name !== exec.name || digestOf(JSON.parse(sourceCall.arguments)) !== digestOf(exec.arguments))) {
    throw new Error('Review arguments differ from the native model call')
  }
  if (exec.parent && sourceCall.name !== 'run_code') throw new Error('Unsupported nested review transport')
  const captured = store.readDocument(`review-request:${agent.id}:${message.data.turn}:${message.data.step}`)
  const row = captured?.value as { schemaVersion?: unknown; sessionId?: unknown; turn?: unknown; step?: unknown; ticket?: ReviewTicket } | undefined
  if (row?.schemaVersion !== 1 || row.sessionId !== agent.id || row.turn !== message.data.turn
    || row.step !== message.data.step || row.ticket?.subject.taskId !== taskId) throw new Error('No captured review ticket for this native request')
  const ticket = captureTicket(row.ticket)
  const evidence = store.putArtifact(taskId, Buffer.from(JSON.stringify({
    schemaVersion: 1, sessionId: agent.id, eventSeq: message.seq, nativeRootCallId: exec.rootCallId,
    nativeCallId: exec.callId, arguments: exec.arguments, assistantCall: sourceCall,
    terminal, ticket,
  })), 'application/vnd.dsh-fusion.native-review+json')
  return { ticket, terminalEvidenceRef: evidence.id,
    finishReason: terminal.chunk.reason.kind === 'tool-calls' ? 'tool_calls' : 'stop' }
}
