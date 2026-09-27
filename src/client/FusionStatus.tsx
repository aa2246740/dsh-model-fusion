import { FusionRecovery } from './FusionRecovery.js'
import { Fragment, useEffect, useState } from 'react'
import type { FusionStatus as Status, UsageSubtotal } from '../status.js'
import { tr, useLang, type Lang } from './i18n.js'

const styles = `
.fusion-status{margin:8px 12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.fusion-status>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:12px;list-style:none;border-top:1px solid var(--dsw-alias-border-l2);outline-offset:2px}
.fusion-status>summary::before{content:'›';font-size:18px;flex:none}.fusion-status[open]>summary::before{content:'⌄'}
.fusion-status>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}
.fusion-status .fusion-status-label{font-weight:600}.fusion-status .fusion-status-count{margin-left:auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fusion-status .fusion-status-detail{max-height:320px;overflow:auto;padding:4px 4px 12px 0;scrollbar-gutter:stable}
.fusion-status .fusion-recovery fieldset{border:0;padding:0;display:flex;flex-direction:column;gap:10px}.fusion-recovery :is(button,select,input){font:inherit;color:inherit;background:var(--dsw-alias-bg-page-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px;max-width:100%}.fusion-recovery button{cursor:pointer}.fusion-recovery :is(button,input,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.fusion-recovery [role=alert]{color:var(--dsw-alias-state-error-primary)}
.fusion-status:has(.fusion-recovery) .fusion-status-detail{max-height:min(65vh,640px)}.fusion-recovery details>summary{padding:8px 0;cursor:pointer}
.fusion-status p{margin:4px 0 12px}.fusion-status h3{font-size:13px;margin:16px 0 4px;font-weight:600}
.fusion-status dl{margin:0;display:grid;grid-template-columns:minmax(72px,auto) minmax(0,1fr);gap:4px 12px}
.fusion-status dt{color:var(--dsw-alias-label-secondary)}.fusion-status dd{margin:0;min-width:0}
.fusion-status ul{list-style:none;margin:0;padding:0}.fusion-status li{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.fusion-status small{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}
@media(max-width:400px){.fusion-status>summary{gap:8px}.fusion-status .fusion-status-detail{max-height:280px}}
`

const role = (value: string) => value === 'lead' ? 'Lead' : 'Sidekick'
const purposeOf = (lang: Lang, value: string) => ({ conversation: tr(lang, '任务', 'task'), compaction: tr(lang, '压缩', 'compaction'),
  'cache-keepalive': tr(lang, '保活', 'keepalive'), 'session-title': tr(lang, '标题', 'title') } as Record<string, string>)[value] ?? value
const outcomeOf = (lang: Lang, value: string) => ({ entered: tr(lang, '请求中', 'in progress'), stop: tr(lang, '已返回', 'returned'), 'tool-calls': tr(lang, '调用工具', 'tool calls'),
  'max-tokens': tr(lang, '输出截断', 'output truncated'), aborted: tr(lang, '已中断', 'aborted'), error: tr(lang, '请求失败', 'failed'), unknown: tr(lang, '结束状态未知', 'unknown end') } as Record<string, string>)[value] ?? value
const toolStateOf = (lang: Lang, value: string) => ({ 'dispatch-started': tr(lang, '执行未收尾', 'unfinished'), returned: tr(lang, '已返回', 'returned'),
  'outcome-unknown': tr(lang, '结果未知', 'outcome unknown'), inspected: tr(lang, '已人工检查', 'inspected') } as Record<string, string>)[value] ?? value
const countOf = (lang: Lang, value: UsageSubtotal) => value.totalRequests === 0 ? '—' : value.reportedRequests === 0 ? tr(lang, '未提供', 'not reported')
  : `${value.knownTokens.toLocaleString()}${value.reportedRequests < value.totalRequests ? tr(lang, `（${value.reportedRequests}/${value.totalRequests} 次有报告）`, ` (${value.reportedRequests}/${value.totalRequests} reported)`) : ''}`
const noteStyle = { margin: '8px 12px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 }

/** Visible-session polling reads the plugin ledger; it never sends a chat message. */
export function FusionStatus({ sessionId, attentionOnly = false }: { sessionId: string; attentionOnly?: boolean }) {
  const lang = useLang()
  const purpose = (value: string) => purposeOf(lang, value), outcome = (value: string) => outcomeOf(lang, value)
  const toolState = (value: string) => toolStateOf(lang, value), count = (value: UsageSubtotal) => countOf(lang, value)
  const [snapshot, setSnapshot] = useState<{ sessionId: string; status?: Status; failed: boolean }>()
  useEffect(() => {
    let active = true, busy = false, timer: ReturnType<typeof setTimeout> | undefined
    let abort: AbortController | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const refresh = async () => {
      if (!active || busy || !visible()) return
      if (timer) clearTimeout(timer)
      busy = true; abort = new AbortController()
      const deadline = setTimeout(() => {
        if (active && visible()) setSnapshot({ sessionId, failed: true })
        abort?.abort()
      }, 10000)
      try {
        const response = await fetch(`/api/model-fusion?view=status&sessionId=${encodeURIComponent(sessionId)}`,
          { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('unavailable')
        const status = await response.json() as Status
        if (status.schemaVersion !== 1 || status.sessionId !== sessionId) throw new Error('mismatched status')
        if (active && !abort.signal.aborted) setSnapshot({ sessionId, status, failed: false })
      } catch {
        if (active && !abort.signal.aborted) setSnapshot({ sessionId, failed: true })
      } finally {
        clearTimeout(deadline)
        busy = false
        if (active && visible()) timer = setTimeout(() => { void refresh() }, 2000)
      }
    }
    const visibility = () => {
      if (timer) clearTimeout(timer)
      if (!visible()) abort?.abort()
      else void refresh()
    }
    void refresh()
    document.addEventListener('visibilitychange', visibility)
    return () => { active = false; abort?.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [sessionId])
  if (!snapshot || snapshot.sessionId !== sessionId) return attentionOnly ? null : <p style={noteStyle} role="status">{tr(lang, '正在读取 Fusion 状态…', 'Loading Fusion status…')}</p>
  if (snapshot.failed) return attentionOnly ? null : <p style={noteStyle} role="status">{tr(lang, 'Fusion 状态暂时无法更新，恢复连接后会重试。可用 /fusion status 查看。', 'Fusion status cannot update right now; it retries when reconnected. Use /fusion status.')}</p>
  const task = snapshot.status?.task
  if (!snapshot.status?.selected || !task) return null
  if (attentionOnly && !task.attention) return null
  const { usage } = task
  const verification = task.automatedChecks === 0 && task.verification === 'verified' ? tr(lang, '仅经 Lead 审查（未运行自动检查）', 'Lead review only (no automated checks ran)')
    : ({ verified: tr(lang, '验证通过', 'verified'), partial: tr(lang, '部分验证', 'partly verified'), unverified: tr(lang, '尚未验证', 'unverified') })[task.verification]
  const stage = lang === 'en' ? task.stageEn ?? task.stage : task.stage, detail = lang === 'en' && task.detailEn !== undefined ? task.detailEn : task.detail
  const share = (role: 'lead' | 'worker') => {
    const total = usage.byRole.lead.output.knownTokens + usage.byRole.worker.output.knownTokens
    return total ? tr(lang, ` · 输出占 ${Math.round(usage.byRole[role].output.knownTokens / total * 100)}%`, ` · ${Math.round(usage.byRole[role].output.knownTokens / total * 100)}% of output`) : ''
  }
  return <details className="fusion-status" key={task.id}>
    <style>{styles}</style>
    <summary aria-label={tr(lang, `Fusion · ${stage}，任务详情`, `Fusion · ${stage}, task details`)} data-ud-check="fusion-status-summary">
      <span className="fusion-status-label" role="status">Fusion · {stage}</span>
      <span className="fusion-status-count">{tr(lang, `${usage.calls} 次请求`, `${usage.calls} requests`)}</span><span>{tr(lang, '详情', 'Details')}</span>
    </summary>
    <div className="fusion-status-detail" tabIndex={0} aria-label={tr(lang, 'Fusion 任务详情', 'Fusion task details')} data-ud-check="fusion-status-detail">
      <p>{detail ?? (task.stage === '完成' ? tr(lang, `本轮任务已结束 · ${verification}`, `This task has finished · ${verification}`) : tr(lang, `本轮任务 · ${verification}`, `This task · ${verification}`))}</p>
      {task.modelControl && task.stage !== '完成' && <FusionRecovery sessionId={sessionId} task={task} />}
      <dl>
        <dt>Lead</dt><dd>{task.models.lead.model}<small>{task.models.lead.provider}</small></dd>
        <dt>Sidekick</dt><dd>{task.models.worker.model}<small>{task.models.worker.provider}{task.workerId ? tr(lang, ' · 已建立持续会话', ' · persistent session') : tr(lang, ' · 尚未委派', ' · not delegated yet')}</small></dd>
        {task.models.compactor && <><dt>{tr(lang, '压缩模型', 'Compaction')}</dt><dd>{task.models.compactor.model}<small>{task.models.compactor.provider}</small></dd></>}
        <dt>{tr(lang, '待确认', 'Pending approvals')}</dt><dd>{task.pendingApprovals}</dd>
        <dt>{tr(lang, '未收尾工具', 'Unsettled tools')}</dt><dd>{task.unsettledTools}</dd>
      </dl>
      <h3>{tr(lang, '本轮用量', 'Usage this task')}</h3>
      <dl>
        <dt>{tr(lang, '模型请求', 'Model requests')}</dt><dd>{usage.calls}<small>{tr(lang, `含压缩 ${usage.compactionCalls} 次、保活 ${usage.keepaliveCalls} 次`, `incl. ${usage.compactionCalls} compaction, ${usage.keepaliveCalls} keepalive`)}</small></dd>
        <dt>{tr(lang, '用量报告', 'Usage reports')}</dt><dd>{tr(lang, `${usage.finalCalls} 次已定稿 · ${usage.provisionalCalls} 次暂报 · ${usage.unreportedCalls} 次未提供`, `${usage.finalCalls} final · ${usage.provisionalCalls} provisional · ${usage.unreportedCalls} unreported`)}</dd>
        <dt>{tr(lang, '输入 Token', 'Input tokens')}</dt><dd>{count(usage.input)}<small>{tr(lang, '已报告的未缓存输入', 'reported uncached input')}</small></dd>
        <dt>{tr(lang, '缓存读取', 'Cache read')}</dt><dd>{count(usage.cacheRead)}</dd>
        <dt>{tr(lang, '输出 Token', 'Output tokens')}</dt><dd>{count(usage.output)}</dd>
        <dt>{tr(lang, '实际费用', 'Actual cost')}</dt><dd>{tr(lang, '未知', 'unknown')}<small>{tr(lang, '当前账号未提供可靠账单金额', 'the account reports no reliable billed amount')}</small></dd>
      </dl>
      <h3>{tr(lang, '按角色', 'By role')}</h3>
      <dl>
        {(['lead', 'worker'] as const).map(role => <Fragment key={role}>
          <dt>{role === 'lead' ? 'Lead' : 'Sidekick'}</dt>
          <dd>{tr(lang, `${usage.byRole[role].calls} 次`, `${usage.byRole[role].calls} requests`)} · {tr(lang, '输出', 'output')} {count(usage.byRole[role].output)}
            <small>{tr(lang, '输入', 'input')} {count(usage.byRole[role].input)} · {tr(lang, '缓存读取', 'cache read')} {count(usage.byRole[role].cacheRead)}{share(role)}</small></dd>
        </Fragment>)}
      </dl>
      <small>{tr(lang, 'Token 数包含暂报数据；缺失字段不计为 0。请求数来自 DSH，供应商内部重试次数未知。', 'Token counts include provisional data; missing fields are not counted as 0. Request counts come from DSH; provider-internal retries are unknown.')}</small>
      <h3>{tr(lang, '最近上下文检查', 'Recent context checks')}</h3>
      {task.contexts.length ? <ul>{task.contexts.map(context => <li key={context.role}>{role(context.role)} · {purpose(context.purpose)} · {context.admitted ? tr(lang, '可发送', 'admitted') : tr(lang, '超出预算', 'over budget')}
        <small>{context.inputTokens.toLocaleString()} / {context.budget.toLocaleString()} Token · {context.quality === 'exact' ? tr(lang, '精确计数', 'exact') : tr(lang, '估算', 'estimated')}</small>
      </li>)}</ul> : <small>{tr(lang, '尚无上下文检查记录。', 'No context checks yet.')}</small>}
      <h3>{tr(lang, '最近模型请求', 'Recent model requests')}</h3>
      {task.requests.length ? <ul>{task.requests.map(request => <li key={request.id}>{role(request.role)} · {purpose(request.purpose)} · {outcome(request.outcome)}
        <small>{request.model} · {request.provider} · {request.authority === 'final' ? tr(lang, '用量已定稿', 'usage final') : request.authority === 'provisional' ? tr(lang, '用量暂报', 'usage provisional') : tr(lang, '用量未提供', 'usage not reported')}</small>
      </li>)}</ul> : <small>{tr(lang, '尚未发出模型请求。', 'No model requests yet.')}</small>}
      <h3>{tr(lang, '最近命令与写入', 'Recent commands and writes')}</h3>
      {task.tools.length ? <ul>{task.tools.map(tool => <li key={tool.id}>{role(tool.role)} · {tool.name} · {tool.failed ? tr(lang, '返回错误', 'error') : toolState(tool.state)}</li>)}</ul>
        : <small>{tr(lang, '尚无工具执行记录。', 'No tool runs yet.')}</small>}
      <small>{tr(lang, '显示最近 12 次请求、8 项命令或写入操作；用量汇总覆盖本轮全部请求。读取操作仍可在会话中查看。', 'Shows the last 12 requests and 8 commands or writes; usage totals cover all requests of this task. Reads remain visible in the conversation.')}</small>
    </div>
  </details>
}
