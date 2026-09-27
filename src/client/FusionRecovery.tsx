import { useState } from 'react'
import { tr, useLang } from './i18n.js'
import type { FusionStatus } from '../status.js'
import type { PhysicalRoute } from '../contracts.js'
import type { SettingsCatalog } from '../host/settings.js'
import { ModelChoice } from './FusionSettings.js'

export function FusionRecovery({ sessionId, task }: { sessionId: string; task: NonNullable<FusionStatus['task']> }) {
  const lang = useLang()
  const control = task.modelControl!
  const [role, setRole] = useState<'lead' | 'worker'>('lead')
  const [route, setRoute] = useState<PhysicalRoute>()
  const [catalog, setCatalog] = useState<SettingsCatalog>()
  const [dueAt, setDueAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const action = async (name: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/model-fusion', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, sessionId, taskId: task.id,
          revision: control.revision, role, route, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}) }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? tr(lang, '操作未完成，请刷新状态', 'Not completed; refresh the status'))
      setNotice(name === 'schedule' ? tr(lang, '已设置一次定时继续。Host 需要运行；新消息会取消安排。', 'One scheduled continuation is set. The Host must be running; a new message cancels it.') : name === 'cancel-schedule' ? tr(lang, '已取消定时继续。', 'Scheduled continuation cancelled.') : tr(lang, '已提交继续操作，状态将自动更新。', 'Continuation submitted; the status updates automatically.'))
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const loadCatalog = async () => {
    setError('')
    try {
      const response = await fetch('/api/model-fusion?view=catalog', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(tr(lang, '无法读取模型列表', 'Cannot read the model list'))
      const value = await response.json() as SettingsCatalog
      setCatalog({ ...value, groups: value.groups.filter(group => group.id !== 'dsh-model-fusion') })
    } catch (error) { setError(String(error)) }
  }
  return <section className="fusion-recovery" aria-label={tr(lang, 'Fusion 恢复操作', 'Fusion recovery')}>
    <h3>{tr(lang, '继续当前任务', 'Continue this task')}</h3>
    {Object.entries(control.waits).filter(([, wait]) => wait?.taskId === task.id).map(([key, wait]) => <p key={key}>
      {key === 'lead' ? 'Lead' : 'Sidekick'} · {wait!.code} · {wait!.code === 'NO_PROGRESS' ? tr(lang, '重复操作没有进展，请调整做法', 'Repeated steps made no progress; change the approach') : wait!.code === 'WORKFLOW_INCOMPLETE' ? tr(lang, '报告、委派或审查尚未完成，请检查任务后继续', 'A report, handoff or review is unfinished; check the task, then continue') : wait!.code.includes('QUOTA') ? tr(lang, '额度重置时间未知', 'Quota reset time unknown') : tr(lang, '需要处理模型错误', 'A model error needs attention')}
      {wait!.retryNotBefore && <small>{tr(lang, '服务商建议重试时间', 'Provider retry hint')}: {new Date(wait!.retryNotBefore).toLocaleString()} {tr(lang, '（不代表额度重置）', '(not a quota reset)')}</small>}
    </p>)}
    {control.schedule && <p role="status">{tr(lang, '定时继续', 'Scheduled continuation')}: {new Date(control.schedule.dueAt).toLocaleString()} · {
      ({ scheduled: tr(lang, '已安排', 'scheduled'), cancelled: tr(lang, '已取消', 'cancelled'), fired: tr(lang, '已执行一次', 'ran once'), failed: tr(lang, '未能执行', 'failed') })[control.schedule.state]}{control.schedule.reason ? ` · ${control.schedule.reason}` : ''}</p>}
    {control.operation && ['prepared', 'dispatching'].includes(control.operation.state) && <p role="alert">{tr(lang, '上次继续操作的投递结果尚未确认。请检查会话；系统不会自动重发。', 'Delivery of the last continuation is unconfirmed. Check the conversation; nothing is resent automatically.')}</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy || task.unsettledTools > 0 || task.pendingApprovals > 0}>
      <button onClick={() => { void action('continue') }}>{tr(lang, '继续一次', 'Continue once')}</button>
      <details><summary onClick={() => { if (!catalog) void loadCatalog() }}>{tr(lang, '更换角色模型并继续', 'Switch a role model and continue')}</summary>
        <label>{tr(lang, '角色', 'Role')} <select value={role} onChange={event => { setRole(event.target.value as 'lead' | 'worker'); setRoute(undefined) }}>
          <option value="lead">Lead</option><option value="worker">Sidekick</option>
        </select></label>
        {catalog && <ModelChoice role={role === 'lead' ? 'Lead' : 'Sidekick'} route={route} catalog={catalog} onChange={setRoute} />}
        <p>{tr(lang, '仅更换当前会话的角色模型，保留任务与 Sidekick 会话。后续请求使用新模型的账号。', 'Changes this conversation\'s role model only; the task and the Sidekick session are kept. Later requests use the new model\'s account.')}</p>
        <button disabled={!route} onClick={() => { void action('switch-role') }}>{tr(lang, '更换并继续一次', 'Switch and continue once')}</button>
      </details>
      <details><summary>{tr(lang, '定时继续一次', 'Continue once at a time')}</summary>
        <label>{tr(lang, '本地时间', 'Local time')} <input aria-label={tr(lang, '定时继续时间', 'Continuation time')} type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} /></label>
        <p>{tr(lang, '按你选择的时间尝试一次；再次遇到额度错误会停止。此时间不代表服务商承诺的恢复时间。', 'Tries once at the time you choose and stops on another quota error. It is not a provider-promised reset time.')}</p>
        <button disabled={!dueAt} onClick={() => { void action('schedule') }}>{tr(lang, '设置时间', 'Set time')}</button>
        {control.schedule?.state === 'scheduled' && <button onClick={() => { void action('cancel-schedule') }}>{tr(lang, '取消安排', 'Cancel')}</button>}
      </details>
    </fieldset>
  </section>
}
