import { readModelControl } from './native-model-control.js'
import type { TaskState } from '../task/state.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { Role, TaskId, TokenMeasurement } from '../contracts.js'
import type { FusionStatus, UsageSubtotal } from '../status.js'
import { projectLedger, restoreLedger, type Count } from '../usage/ledger.js'
import { BindingRepository } from './bindings.js'
import type { NativeUsageRecord } from './native-usage.js'
import type { RoleUsage } from '../status.js'

interface EffectRow {
  schemaVersion: 1; taskId: TaskId; role: Role; toolName: string; state: string
  nativeIsError?: boolean; startedAt: string
}
interface ContextRow {
  schemaVersion: 1; taskId: TaskId; role: Role; purpose: string; checkedAt: string
  measurement: TokenMeasurement; budget: number; admitted: boolean
}

/** English copies of the stage and detail texts; the client shows them when DSH runs in English. */
const EN: Record<string, string> = {
  '正在停止': 'Stopping', '正在等待已启动的操作收尾。': 'Waiting for started operations to finish.',
  '等待检查': 'Needs inspection', '请先核对中断的操作，再使用 /fusion recover 提交检查记录。': 'Check the interrupted operations, then record the inspection with /fusion recover.',
  '已取消': 'Cancelled', '等待确认': 'Waiting for approval', '请在 DSH 的权限提示中处理待确认操作。': 'Handle the pending approval in DSH\'s permission prompt.',
  '等待额度': 'Waiting for quota', '请前往设置 → Fusion 查看额度，处理后使用 /fusion resume。': 'See Settings → Fusion for the quota, then use /fusion resume.',
  '已暂停': 'Paused', '使用 /fusion status 查看状态，确认后可用 /fusion resume 继续。': 'Check /fusion status, then continue with /fusion resume.',
  '完成': 'Done', '验证': 'Verifying',
  'Worker 模型服务提示额度已耗尽，当前任务和文件已保留。恢复额度后发送消息继续。': 'The Sidekick provider reported exhausted quota; the task and files are kept. Send a message to continue once quota is back.',
  '等待反馈': 'Needs your input', 'Worker 已达到本任务的执行次数上限，现有结果已保留。请查看会话中的未完成说明。': 'The Sidekick reached this task\'s step limit; its results are kept. See the unfinished notes in the conversation.',
  '就绪': 'Ready', '探索尚未完成，请查看会话中的阻塞说明；补充信息后会继续原 Worker。': 'Exploration is unfinished: see the blocker in the conversation; the same Sidekick continues once you add the information.',
  '分析': 'Analysing', '执行': 'Working', '修改': 'Revising', '审查': 'Reviewing',
  '请处理 DSH 的待确认操作。': 'Handle the pending DSH approval.', '请查看会话中的问题或阻塞说明。': 'See the question or blocker in the conversation.',
  '请前往设置 → Fusion 查看调用额度。': 'See Settings → Fusion for the request quota.', '请查看 /fusion status 并核对中断的操作。': 'Check /fusion status and the interrupted operations.',
  '确认任务状态后，使用 /fusion resume 继续。': 'Confirm the task state, then continue with /fusion resume.',
  '未完成': 'Unfinished', '请查看会话中的错误和 /fusion status。': 'See the error in the conversation and /fusion status.',
  '完成状态尚未确认，请查看 /fusion status。': 'Completion is unconfirmed; see /fusion status.',
  '需要调整做法': 'Needs a different approach', '等待模型': 'Waiting for the model',
  '继续消息的投递结果尚未确认。检查会话后使用 /fusion recover 提交检查记录。': 'Delivery of the continuation is unconfirmed. Check the conversation, then use /fusion recover.',
}
const english = (text: string | null | undefined) => text == null ? text : EN[text] ?? text

export function taskStage(state: TaskState, checking: boolean, workerStepLimitReached = false, workerQuotaExhausted = false): Pick<NonNullable<FusionStatus['task']>, 'stage' | 'detail' | 'attention'> {
  const control = state.control
  const value = (stage: string, detail: string | null = null, attention = false) => ({ stage, detail, attention })
  if (control.mode === 'stop-requested') return value('正在停止', '正在等待已启动的操作收尾。', true)
  if (control.recovering || control.outcomeUnknown) return value('等待检查', '请先核对中断的操作，再使用 /fusion recover 提交检查记录。', true)
  if (control.mode === 'cancelled') return value('已取消')
  if (control.pendingApprovalIds.length) return value('等待确认', '请在 DSH 的权限提示中处理待确认操作。', true)
  if (control.budgetBlocked) return value('等待额度', '请前往设置 → Fusion 查看额度，处理后使用 /fusion resume。', true)
  if (control.mode === 'paused') return value('已暂停', '使用 /fusion status 查看状态，确认后可用 /fusion resume 继续。', true)
  if (control.mode === 'completed' && state.phase === 'COMPLETED') return value('完成')
  if (checking) return value('验证')
  if (workerQuotaExhausted && ['WORKER_RUNNING', 'REWORK', 'PLANNING', 'NEEDS_DECISION'].includes(state.phase)) {
    return value('等待额度', 'Worker 模型服务提示额度已耗尽，当前任务和文件已保留。恢复额度后发送消息继续。', true)
  }
  if (workerStepLimitReached && ['WORKER_RUNNING', 'REWORK', 'PLANNING', 'NEEDS_DECISION'].includes(state.phase)) {
    return value('等待反馈', 'Worker 已达到本任务的执行次数上限，现有结果已保留。请查看会话中的未完成说明。', true)
  }
  switch (state.phase) {
    case 'READY': return value('就绪')
    case 'PLANNING': return state.currentWorkOrder?.mode === 'explore' && state.exploration && state.exploration.status !== 'completed'
      ? value('等待反馈', '探索尚未完成，请查看会话中的阻塞说明；补充信息后会继续原 Worker。', true) : value('分析')
    case 'DIRECT': case 'WORKER_RUNNING': return value('执行')
    case 'REWORK': return value('修改')
    case 'REVIEWING': return value('审查')
    case 'WAITING_APPROVAL': return value('等待确认', '请处理 DSH 的待确认操作。', true)
    case 'WAITING_USER': case 'NEEDS_DECISION': return value('等待反馈', '请查看会话中的问题或阻塞说明。', true)
    case 'WAITING_BUDGET': return value('等待额度', '请前往设置 → Fusion 查看调用额度。', true)
    case 'RECOVERING': return value('等待检查', '请查看 /fusion status 并核对中断的操作。', true)
    case 'PAUSED': return value('已暂停', '确认任务状态后，使用 /fusion resume 继续。', true)
    case 'STOPPING': return value('正在停止', null, true)
    case 'FAILED': return value('未完成', '请查看会话中的错误和 /fusion status。', true)
    case 'CANCELLED': return value('已取消')
    case 'COMPLETED': return value('等待检查', '完成状态尚未确认，请查看 /fusion status。', true)
  }
}

function subtotal(counts: (Count | undefined)[]): UsageSubtotal {
  const known = counts.filter((count): count is Extract<Count, { state: 'known' }> => count?.state === 'known')
  return { knownTokens: known.reduce((sum, count) => sum + count.tokens, 0),
    reportedRequests: known.length, totalRequests: counts.length }
}

/** Reads existing durable facts only. Polling never constructs a runtime or calls a model. */
export function readFusionStatus(store: SqliteFusionStore, sessionId: string): FusionStatus {
  const binding = new BindingRepository(store).read(sessionId)?.binding
  const base: FusionStatus = { schemaVersion: 1, sessionId, selected: Boolean(binding?.selected), observedAt: new Date().toISOString() }
  if (!binding?.selected) return base
  const taskId = binding.taskId, state = store.load(taskId)
  if (!state || state.parent !== sessionId || state.profileDigest !== binding.profile.digest) throw new Error('Fusion 任务记录不一致，请检查存档')
  const rows = <T extends { schemaVersion: number; taskId: TaskId }>(prefix: string): { id: string; row: T }[] =>
    store.listDocumentIds(`${prefix}:${taskId}:`).map(id => {
      const row = store.readDocument(id)?.value as T | undefined
      if (!row || row.schemaVersion !== 1 || row.taskId !== taskId) throw new Error('Fusion 状态记录需要检查')
      return { id, row }
    })
  const usage = rows<NativeUsageRecord>('usage').map(({ id, row }) => ({ id, row, projection: projectLedger(restoreLedger(row.ledger)) }))
  const effects = rows<EffectRow>('native-effect')
  const checking = store.listDocumentIds(`check-invocation:${taskId}:`).some(id => {
    const row = store.readDocument(id)?.value as { evidence?: { taskId?: string; state?: string } } | undefined
    if (!row?.evidence || row.evidence.taskId !== taskId) throw new Error('Fusion 验证记录需要检查')
    return row.evidence.state === 'started'
  })
  const contexts = rows<ContextRow>('context-request').sort((a, b) => b.row.checkedAt.localeCompare(a.row.checkedAt))
  const runtime = store.readDocument(`runtime:${taskId}`)?.value as { schemaVersion?: number; taskId?: string;
    workerStepStop?: { workOrderId?: string; requests: number; limit: number };
    workerFailure?: { workOrderId?: string; childId?: string; category?: string } } | undefined
  const stop = runtime?.workerStepStop
  const workerStepLimitReached = runtime?.schemaVersion === 1 && runtime.taskId === taskId && Boolean(stop
    && state.currentWorkOrder && stop.workOrderId === state.currentWorkOrder.id && stop.limit > 0 && stop.requests >= stop.limit)
  const failure = runtime?.workerFailure
  const workerQuotaExhausted = runtime?.schemaVersion === 1 && runtime.taskId === taskId && Boolean(failure
    && state.currentWorkOrder && failure.workOrderId === state.currentWorkOrder.id && failure.childId === state.acceptedChild
    && failure.category === 'quota-exhausted')
  const modelControl = readModelControl(store, binding)
  const waiting = modelControl && Object.entries(modelControl.waits).filter(([, wait]) => wait?.taskId === taskId)
  const modelStage = waiting?.length && state.control.mode !== 'completed' && state.control.mode !== 'cancelled' && !state.control.budgetBlocked && !checking && !state.control.recovering && !state.control.outcomeUnknown && !state.control.pendingApprovalIds.length
    ? { stage: waiting.some(([, wait]) => ['NO_PROGRESS', 'WORKFLOW_INCOMPLETE'].includes(wait!.code)) ? '需要调整做法' : '等待模型',
      detail: `${waiting.map(([role]) => role === 'lead' ? 'Lead' : 'Sidekick').join('、')} 已暂停。请查看原因后继续。`,
      detailEn: `${waiting.map(([role]) => role === 'lead' ? 'Lead' : 'Sidekick').join(' and ')} paused. See the reason, then continue.`, attention: true } : {}
  const pendingDelivery = modelControl?.operation && ['prepared', 'dispatching'].includes(modelControl.operation.state)
    ? { stage: '等待检查', detail: '继续消息的投递结果尚未确认。检查会话后使用 /fusion recover 提交检查记录。', attention: true } : {}
  const stage = { ...taskStage(state, checking, workerStepLimitReached, workerQuotaExhausted), ...modelStage, ...pendingDelivery }
  return { ...base, task: { id: taskId, revision: state.revision, ...stage, stageEn: english(stage.stage)!,
    detailEn: 'detailEn' in stage && stage.detailEn ? stage.detailEn : english(stage.detail) ?? null, ...(modelControl ? { modelControl } : {}), verification: state.verification,
    workerId: state.acceptedChild ?? binding.workerId ?? null,
    models: { lead: modelControl?.routes.lead ?? binding.profile.lead, worker: modelControl?.routes.worker ?? binding.profile.worker, compactor: binding.profile.compactor?.route ?? null },
    usage: { calls: usage.length, finalCalls: usage.filter(item => item.projection.authority === 'final').length,
      provisionalCalls: usage.filter(item => item.projection.authority === 'provisional').length,
      unreportedCalls: usage.filter(item => item.projection.authority === 'none').length,
      compactionCalls: usage.filter(item => item.row.purpose === 'compaction').length,
      keepaliveCalls: usage.filter(item => item.row.purpose === 'cache-keepalive').length,
      input: subtotal(usage.map(item => item.projection.bill?.uncachedInput)),
      cacheRead: subtotal(usage.map(item => item.projection.bill?.cacheRead)),
      output: subtotal(usage.map(item => item.projection.bill?.output)), actualBilledUsd: null, upstreamHttpCalls: null,
      byRole: Object.fromEntries((['lead', 'worker'] as const).map(role => {
        const own = usage.filter(item => item.row.role === role)
        return [role, { calls: own.length, input: subtotal(own.map(item => item.projection.bill?.uncachedInput)),
          cacheRead: subtotal(own.map(item => item.projection.bill?.cacheRead)), output: subtotal(own.map(item => item.projection.bill?.output)) }]
      })) as Record<'lead' | 'worker', RoleUsage> },
    automatedChecks: Array.isArray((runtime as { checks?: unknown[] } | undefined)?.checks) && runtime?.taskId === taskId
      ? (runtime as { checks: unknown[] }).checks.length : null,
    requests: usage.sort((a, b) => b.row.startedAt.localeCompare(a.row.startedAt)).slice(0, 12).map(({ id, row, projection }) => ({
      id, role: row.role, purpose: row.purpose, provider: row.ledger.key.provider, model: row.ledger.key.model,
      outcome: row.outcome, authority: projection.authority, startedAt: row.startedAt })),
    tools: effects.sort((a, b) => b.row.startedAt.localeCompare(a.row.startedAt)).slice(0, 8).map(({ id, row }) => ({
      id, role: row.role, name: row.toolName, state: row.state, failed: row.nativeIsError === true, startedAt: row.startedAt })),
    contexts: (['lead', 'worker'] as const).flatMap(role => {
      const row = contexts.find(item => item.row.role === role)?.row
      return row ? [{ role, purpose: row.purpose, inputTokens: row.measurement.inputTokens, budget: row.budget,
        quality: row.measurement.quality, admitted: row.admitted, checkedAt: row.checkedAt }] : []
    }),
    pendingApprovals: state.control.pendingApprovalIds.length,
    unsettledTools: effects.filter(({ row }) => row.state === 'dispatch-started' || row.state === 'outcome-unknown').length,
  } }
}
