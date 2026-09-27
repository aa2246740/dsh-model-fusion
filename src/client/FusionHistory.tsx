import { useEffect, useState } from 'react'
import type { HistoryView, HistoryTotals } from '../host/history.js'
import { tr, useLang, type Lang } from './i18n.js'

const takeoverReason = (lang: Lang, reason: string) => ({
  'checks-still-failing': tr(lang, '返工后检查仍失败', 'checks still failing after rework'),
  'worker-step-limit': tr(lang, 'Sidekick 步数用尽', 'Sidekick step limit'),
  'worker-stalled': tr(lang, 'Sidekick 反复停滞', 'Sidekick stalled repeatedly'),
} as Record<string, string>)[reason] ?? reason
const tokens = (lang: Lang, field: HistoryTotals['input'], calls: number) => !calls ? '—' : !field.reported ? tr(lang, '未提供', 'not reported')
  : `${field.known.toLocaleString()}${field.reported < calls ? tr(lang, `（${field.reported}/${calls} 次有报告）`, ` (${field.reported}/${calls} reported)`) : ''}`
const purpose = (lang: Lang, value: string) => ({ conversation: tr(lang, '任务', 'task'), compaction: tr(lang, '压缩', 'compaction'),
  'cache-keepalive': tr(lang, '保活', 'keepalive'), 'session-title': tr(lang, '标题', 'title') } as Record<string, string>)[value] ?? value

export function FusionHistory() {
  const lang = useLang()
  const [page, setPage] = useState<HistoryView>()
  const [cursor, setCursor] = useState('')
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/model-fusion?view=history&cursor=${encodeURIComponent(cursor)}`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(tr(lang, '历史记录暂时无法读取', 'History is unavailable right now')); return response.json() as Promise<HistoryView> })
      .then(setPage).catch(error => { if (!abort.signal.aborted) setError(String(error)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [cursor, refresh, lang])
  return <section className="fusion-history" aria-label={tr(lang, 'Fusion 历史与统计', 'Fusion history and statistics')} data-ud-check="fusion-history">
    <h2>{tr(lang, '历史与统计', 'History and statistics')}</h2>
    <p>{tr(lang, '按实际模型请求汇总，包含任务、压缩、保活及已有标题请求。未报告的用量不算作 0；金额与节省率尚无可靠数据。',
      'Totals of actual model requests: tasks, compaction, keepalive and title requests. Unreported usage is not counted as 0; no reliable billed amount or saving rate is available.')}</p>
    <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>{tr(lang, '刷新记录', 'Refresh')}</button>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">{tr(lang, '正在读取记录…', 'Loading…')}</p>}
    {page && <>
      <p>{tr(lang, `${page.totalTasks} 项任务 · ${page.totals.calls} 次原生请求 · ${page.totals.final} 次用量定稿 · ${page.totals.provisional} 次暂报 · ${page.totals.unreported} 次未提供`,
        `${page.totalTasks} tasks · ${page.totals.calls} native requests · ${page.totals.final} final usage · ${page.totals.provisional} provisional · ${page.totals.unreported} unreported`)}</p>
      <p>{tr(lang, '未缓存输入', 'Uncached input')} {tokens(lang, page.totals.input, page.totals.calls)} · {tr(lang, '缓存读取', 'cache read')} {tokens(lang, page.totals.cacheRead, page.totals.calls)} · {tr(lang, '输出', 'output')} {tokens(lang, page.totals.output, page.totals.calls)} Token</p>
      <p>{tr(lang, `Lead 接手改代码 ${page.takeovers?.total ?? 0} 次（${page.takeovers?.tasks ?? 0} 项任务）`, `Lead takeovers: ${page.takeovers?.total ?? 0} (${page.takeovers?.tasks ?? 0} tasks)`)}
        {page.takeovers?.total ? `: ${Object.entries(page.takeovers.reasons).map(([reason, count]) => `${takeoverReason(lang, reason)} ${count}`).join(', ')}` : ''}
        {tr(lang, '。只有 Sidekick 确实完成不了时，程序才会解锁接手。', '. The Host unlocks a takeover only when the Sidekick demonstrably cannot finish.')}</p>
      <div style={{ overflowX: 'auto' }} tabIndex={0} aria-label={tr(lang, '按实际模型统计', 'By actual model')}>
        <table><caption>{tr(lang, '按角色、实际模型和请求用途', 'By role, actual model and purpose')}</caption><thead><tr>
          <th scope="col">{tr(lang, '角色 / 模型', 'Role / model')}</th><th scope="col">{tr(lang, '用途', 'Purpose')}</th><th scope="col">{tr(lang, '请求', 'Requests')}</th><th scope="col">{tr(lang, '输出 Token', 'Output tokens')}</th></tr></thead>
          <tbody>{page.groups.map(group => <tr key={JSON.stringify([group.role, group.provider, group.model, group.purpose])}>
            <th scope="row">{group.role === 'lead' ? 'Lead' : 'Sidekick'} · {group.model}<small>{group.provider}</small></th>
            <td>{purpose(lang, group.purpose)}</td><td>{group.calls}</td><td>{tokens(lang, group.output, group.calls)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <h3>{tr(lang, '任务记录', 'Tasks')}</h3>
      {!page.tasks.length && <p>{tr(lang, '还没有 Fusion 任务。', 'No Fusion tasks yet.')}</p>}
      <ol>{page.tasks.map(task => <li key={task.id}>
        <strong>{task.title}</strong><small>{new Date(task.createdAt).toLocaleString()} · {task.mode === 'completed' ? tr(lang, '已结束', 'finished') : task.phase} · {tr(lang, `${task.usage.calls} 次请求`, `${task.usage.calls} requests`)}{task.takeovers ? tr(lang, ` · Lead 接手 ${task.takeovers} 次`, ` · ${task.takeovers} Lead takeovers`) : ''}</small>
        <details><summary>{tr(lang, '记录详情', 'Details')}</summary><p>{tr(lang, '任务', 'Task')}: {task.id}</p><p>{tr(lang, '会话', 'Session')}: {task.sessionId}</p>
          <p>{tr(lang, `验证状态：${task.verification}。历史运行状态不代表当前仍在执行。`, `Verification: ${task.verification}. A recorded state does not mean it is still running.`)}</p>
          <p>{tr(lang, '输入', 'Input')} {tokens(lang, task.usage.input, task.usage.calls)} · {tr(lang, '缓存读取', 'cache read')} {tokens(lang, task.usage.cacheRead, task.usage.calls)} · {tr(lang, '输出', 'output')} {tokens(lang, task.usage.output, task.usage.calls)} Token</p>
        </details>
      </li>)}</ol>
      <div className="fusion-actions"><button disabled={loading || !cursor} onClick={() => setCursor('')}>{tr(lang, '最新记录', 'Newest')}</button>
        <button disabled={loading || !page.nextCursor} onClick={() => setCursor(page.nextCursor!)}>{tr(lang, '更早记录', 'Older')}</button></div>
      <p>{tr(lang, `更新于 ${new Date(page.observedAt).toLocaleString()}。供应商内部重试次数未知。`, `Updated ${new Date(page.observedAt).toLocaleString()}. Provider-internal retries are unknown.`)}</p>
    </>}
  </section>
}
