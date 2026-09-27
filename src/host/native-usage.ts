import { usageSummary } from './history.js'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Role, TaskId } from '../contracts.js'
import { digestOf } from '../digest.js'
import { ingestDurable, known, newLedger, unknown } from '../usage/ledger.js'
import type { CanonicalBill, UsageLedgerV2 } from '../usage/ledger.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import { nativeRequestAgent } from './native-request.js'
import type { NativeAuxiliaryRequests } from './native-auxiliary.js'

export interface UsageOwner { readonly taskId: TaskId; readonly role: Role }

/** DSH counters are disjoint; missing provider fields retain unknown applicability. */
export function billFromNativeUsage(usage: TokenUsage | undefined): CanonicalBill {
  const count = (value: number | undefined) => value === undefined ? unknown() : known(value)
  return {
    uncachedInput: count(usage?.inputTokens), cacheRead: count(usage?.cacheReadTokens), output: count(usage?.outputTokens),
    cacheWrite: usage?.cacheWriteTokens === undefined ? { kind: 'unknown' }
      : { kind: 'aggregate', rateKey: 'provider-cache-write-rate-unknown', tokens: known(usage.cacheWriteTokens) },
    reasoning: { kind: 'unknown', tokens: count(usage?.reasoningTokens) },
  }
}

export interface NativeUsageRecord {
  schemaVersion: 1
  taskId: TaskId
  sessionId: string
  role: Role
  purpose: 'conversation' | 'compaction' | 'session-title' | 'cache-keepalive'
  /** Effective request envelope; Host compaction markers can retain their pre-routing cap. */
  maxOutputTokens: number | null
  reasoningEffort?: string
  auxiliary?: { seriesId: string; iteration: number }
  nativeInvocationId: string
  startedAt: string
  endedAt: string | null
  /** Entering a Host stream is observable; the adapter's HTTP retry count is not. */
  nativeStreamInvocations: 1
  upstreamHttpCalls: null
  outcome: 'entered' | 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error' | 'unknown'
  ledger: UsageLedgerV2
  actualSubscriptionChargeUsd: null
  apiEquivalentCostUsd: null
}

/** Read-only stream observer. It neither changes requests nor orchestrates agents. */
export function observeNativeUsage(
  ctx: Context, store: SqliteFusionStore, ownerOf: (agent: Agent) => UsageOwner | undefined,
  auxiliary?: NativeAuxiliaryRequests,
): () => void {
  return ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    const agent = nativeRequestAgent(ctx, options)
    const owner = agent && ownerOf(agent)
    if (!owner || !agent) { yield* next(); return }
    const extra = auxiliary?.get(options)
    const id = `native:${randomUUID()}`
    const key = { provider: options.provider, model: options.model, requestId: id, attemptId: id,
      contractDigest: digestOf({ host: '0.1.5-rc.2', input: 'disjoint', reasoning: 'unknown', missing: 'unknown' }) }
    let ledger = newLedger(key)
    let revision = 0, summaryRevision = 0
    let sequence = 0
    let lastUsage: TokenUsage | undefined
    const record: NativeUsageRecord = {
      schemaVersion: 1, taskId: owner.taskId, sessionId: agent.id, role: owner.role, purpose: extra?.purpose ?? options.purpose ?? 'conversation', nativeInvocationId: id,
      maxOutputTokens: options.maxTokens ?? null,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(extra ? { auxiliary: { seriesId: extra.seriesId, iteration: extra.iteration } } : {}),
      startedAt: new Date().toISOString(), endedAt: null, nativeStreamInvocations: 1, upstreamHttpCalls: null,
      outcome: 'entered', ledger, actualSubscriptionChargeUsd: null, apiEquivalentCostUsd: null,
    }
    const persist = () => {
      const value = { ...record, ledger }
      ;[revision, summaryRevision] = store.writeDocuments([
        { id: `usage:${owner.taskId}:${id}`, expectedRevision: revision, value },
        { id: `usage-index:${owner.taskId}:${id}`, expectedRevision: summaryRevision, value: usageSummary(value) },
      ]) as [number, number]
    }
    persist()
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          lastUsage = chunk.usage
          ledger = ingestDurable(ledger, { id: `${id}:${++sequence}`, key, sequence, mode: 'snapshot', bill: billFromNativeUsage(lastUsage) })
          persist()
        }
        if (chunk.type === 'finish') {
          const kind = chunk.reason.kind
          record.outcome = ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(kind)
            ? kind as NativeUsageRecord['outcome'] : 'unknown'
          record.endedAt = new Date().toISOString()
          if (['stop', 'tool-calls', 'max-tokens'].includes(kind) && lastUsage) {
            ledger = ingestDurable(ledger, { id: `${id}:final`, key, sequence: ++sequence, mode: 'final', bill: billFromNativeUsage(lastUsage) })
          }
          persist()
        }
        yield chunk
      }
    } finally {
      if (record.endedAt === null) {
        record.outcome = options.signal?.aborted ? 'aborted' : 'unknown'
        record.endedAt = new Date().toISOString()
        persist()
      }
    }
  })
}
