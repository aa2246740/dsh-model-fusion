import { FusionHistory } from './FusionHistory.js'
import { FusionCache } from './FusionCache.js'
import { useEffect, useState } from 'react'
import type { PhysicalRoute } from '../contracts.js'
import type { PairChoice, SettingsCatalog } from '../host/settings.js'
import { settingsChanged } from './settings-events.js'
import { tr, useLang } from './i18n.js'

interface SettingsState {
  revision: number
  catalog: SettingsCatalog
  pair: PairChoice | null
  authorized: boolean
  managedAuthorization?: boolean
  reason?: string
}
const styles = `
.fusion-settings{max-width:680px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px}
.fusion-settings h2{margin:0;font-size:22px;line-height:30px;font-weight:600}
.fusion-settings p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.fusion-settings header{display:flex;flex-direction:column;gap:8px}
.fusion-settings .fusion-card{padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;display:flex;flex-direction:column;gap:20px;background:var(--dsw-alias-bg-module-platform)}
.fusion-settings fieldset{padding:0;margin:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:10px}
.fusion-settings legend{font-size:15px;font-weight:600;padding:0 0 4px}
.fusion-settings label{display:grid;grid-template-columns:85px minmax(0,1fr);align-items:center;gap:12px;font-size:13px}
.fusion-settings select{box-sizing:border-box;min-width:0;width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;background:var(--dsw-alias-bg-page-primary);color:inherit;font:inherit}
.fusion-settings .fusion-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.fusion-settings button{border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff);padding:7px 18px;font:inherit;font-size:13px;cursor:pointer}
.fusion-settings button:disabled{opacity:.5;cursor:default}
.fusion-settings :is(button,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fusion-settings [role=alert]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.fusion-settings details{font-size:13px;line-height:21px}
.fusion-settings summary{cursor:pointer;font-weight:500}
.fusion-settings .fusion-limits{display:flex;flex-direction:column;gap:12px;padding-top:14px}
.fusion-settings input[type=number]{min-width:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-page-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px;color:inherit;font:inherit}
.fusion-settings .fusion-consent{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px}
.fusion-cache{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}.fusion-cache h3{margin:0}.fusion-cache-model{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.fusion-cache-model small{display:block;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.fusion-cache-controls{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto;gap:10px;align-items:end}.fusion-cache-controls label{grid-template-columns:1fr;gap:4px}.fusion-cache a{color:var(--dsw-alias-brand-primary)}
@media(max-width:560px){.fusion-cache-controls{grid-template-columns:1fr}}
.fusion-history{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}.fusion-history table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.fusion-history :is(th,td){padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:400;vertical-align:top}.fusion-history caption{text-align:left;font-size:13px;margin-bottom:8px}.fusion-history small{display:block;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.fusion-history ol{padding-left:20px;margin:0}.fusion-history li{padding:10px 0}.fusion-history h3{margin:8px 0 0}.fusion-history p{overflow-wrap:anywhere}
@media(max-width:480px){.fusion-settings label{grid-template-columns:1fr;gap:6px}.fusion-settings .fusion-card{padding:16px}}
`

const key = (route: PhysicalRoute | undefined) => route ? JSON.stringify([route.provider, route.model]) : ''

export function ModelChoice({ role, route, catalog, onChange }: {
  role: 'Lead' | 'Sidekick' | 'compactor'; route?: PhysicalRoute; catalog: SettingsCatalog; onChange(route: PhysicalRoute | undefined): void
}) {
  const lang = useLang()
  const name = role === 'compactor' ? tr(lang, '压缩', 'Compaction') : role
  const model = catalog.groups.find(group => group.id === route?.provider)?.models.find(model => model.id === route?.model)
  return <fieldset>
    <legend>{name}</legend>
    <p>{role === 'Lead' ? tr(lang, '回答问题、制定方案并审查结果。', 'Answers, plans and reviews.') : role === 'Sidekick' ? tr(lang, '执行命令和修改，接收反馈后继续。', 'Runs commands and makes changes, then continues with feedback.') : tr(lang, '整理较早的上下文，供 Lead 或 Worker 继续工作。', 'Summarises older context so the Lead or Sidekick can continue.')}</p>
    <label>{tr(lang, '模型', 'Model')}<select aria-label={tr(lang, `${name} 模型`, `${name} model`)} value={key(route)} onChange={event => {
      if (!event.target.value) { onChange(undefined); return }
      const [provider, model] = JSON.parse(event.target.value) as [string, string]
      onChange({ provider, model })
    }}>
      <option value="" disabled={role !== 'compactor'}>{role === 'compactor' ? tr(lang, '使用当前角色模型', 'Use the role\'s own model') : tr(lang, '选择已连接的模型', 'Choose a connected model')}</option>
      {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
        {group.models.map(model => <option key={model.id} value={key({ provider: group.id, model: model.id })}>{model.name}</option>)}
      </optgroup>)}
    </select></label>
    {model?.reasoning && route && <label>{tr(lang, '推理强度', 'Reasoning')}<select aria-label={tr(lang, `${name} 推理强度`, `${name} reasoning`)} value={route.reasoningEffort ?? ''} onChange={event => {
      const { reasoningEffort: _old, ...physical } = route
      onChange({ ...physical, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) })
    }}>
      <option value="">{tr(lang, '模型默认', 'Model default')}{model.reasoning.defaultEffort ? ` · ${model.reasoning.defaultEffort}` : ''}</option>
      {model.reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
    </select></label>}
  </fieldset>
}

export function FusionSettings() {
  const lang = useLang()
  const [state, setState] = useState<SettingsState>()
  const [draft, setDraft] = useState<Partial<PairChoice>>({})
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [saving, setSaving] = useState(false)
  const chooseModel = (role: 'lead' | 'worker', route: PhysicalRoute) => setDraft(value => ({ ...value, [role]: route,
    ...(value.cacheKeepalive ? { cacheKeepalive: { ...value.cacheKeepalive, [role]: role === 'lead' ? 'auto' : false } } : {}) }))
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/model-fusion?view=settings', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(tr(lang, '无法读取 Fusion 设置', 'Cannot read Fusion settings')); return response.json() as Promise<SettingsState> })
      .then(value => { setState(value); setDraft(value.pair ?? {}) })
      .catch(error => { if (!abort.signal.aborted) setError(String(error)) })
    return () => abort.abort()
  }, [])
  const save = async () => {
    if (!state || !draft.lead || !draft.worker) return
    setSaving(true); setError(undefined); setNotice(undefined)
    try {
      const { outputTokens, ...rest } = draft
      const limits = Object.fromEntries(Object.entries(outputTokens ?? {}).filter(([, tokens]) => Number.isSafeInteger(tokens) && Number(tokens) > 0))
      const pair = { ...rest, ...(Object.keys(limits).length ? { outputTokens: limits } : {}) }
      const response = await fetch('/api/model-fusion', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', revision: state.revision, pair }) })
      const result = await response.json() as { revision: number; error?: string }
      if (!response.ok) throw new Error(result.error ?? tr(lang, '保存失败，请刷新后重试', 'Save failed; refresh and try again'))
      const current = await fetch('/api/model-fusion?view=settings', { credentials: 'same-origin', cache: 'no-store' })
      if (!current.ok) throw new Error(tr(lang, '配置已提交，但暂时无法确认，请刷新', 'Saved, but not confirmed yet; refresh'))
      const confirmed = await current.json() as SettingsState
      setState(confirmed); setDraft(confirmed.pair ?? {})
      settingsChanged()
      setNotice(tr(lang, '组合已保存并启用。可以在模型菜单中选择 Fusion · 自动。', 'Pair saved and enabled. Choose Fusion · auto in the model menu.'))
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return <div className="fusion-settings">
    <style>{styles}</style>
    <header><h2>Fusion</h2><p>{tr(lang, '选择 Lead 和 Sidekick。Lead 处理日常请求、安排工作并审查结果；Sidekick 执行委派的任务。', 'Choose a Lead and a Sidekick. The Lead handles requests, plans and reviews; the Sidekick does the delegated work.')}</p>
      <p><b>{tr(lang, '搭配建议', 'Pairing tip')}</b>: {tr(lang, 'Fusion 省钱靠的是 Sidekick 比 Lead 便宜得多。选一个强的前沿模型当 Lead，再选一个价格低很多（最好 5 倍以上）的模型当 Sidekick；两者价格越接近，越省不了钱。',
        'Fusion saves money because the Sidekick is much cheaper than the Lead. Pick a strong frontier Lead and a Sidekick that costs far less (ideally 5× or more); the closer their prices, the smaller the saving.')}</p></header>
    {error && <p role="alert">{error}</p>}
    {!state && !error && <p role="status">{tr(lang, '正在读取模型…', 'Loading models…')}</p>}
    {state && <>
      <fieldset className="fusion-card" disabled={saving}>
        <ModelChoice role="Lead" route={draft.lead} catalog={state.catalog} onChange={route => { if (route) chooseModel('lead', route) }} />
        <ModelChoice role="Sidekick" route={draft.worker} catalog={state.catalog} onChange={route => { if (route) chooseModel('worker', route) }} />
        <details><summary>{tr(lang, '上下文压缩模型 · 可选', 'Compaction model · optional')}</summary>
          <div className="fusion-limits">
            <p>{tr(lang, '默认由当前角色模型压缩。也可以单独选择已连接的模型；请求由所选账号计费。', 'By default each role compacts with its own model. You can pick another connected model; its account is billed.')}</p>
            <ModelChoice role="compactor" route={draft.compactor?.route} catalog={state.catalog} onChange={route => setDraft(value => {
              const { compactor, ...rest } = value
              return route ? { ...rest, compactor: { route, maxOutputTokens: compactor?.maxOutputTokens ?? 8192 } } : rest
            })} />
            {draft.compactor && <label>{tr(lang, '输出 Token 上限', 'Output token limit')}<input aria-label={tr(lang, '压缩输出 Token 上限', 'Compaction output token limit')} type="number" min="1" max="128000"
              value={draft.compactor.maxOutputTokens} onChange={event => { const maxOutputTokens = Number(event.target.value)
                setDraft(value => value.compactor ? { ...value, compactor: { ...value.compactor, maxOutputTokens } } : value) }} /></label>}
            <p>{tr(lang, '已选中的会话仍使用原配置。', 'Conversations already using Fusion keep their setup.')}</p>
          </div>
        </details>
      </fieldset>
      <div className="fusion-actions"><p>{tr(lang, '已选中的会话保留原组合；新选择使用新组合。', 'Conversations already using Fusion keep their pair; new selections use the new one.')}</p>
        <button disabled={saving || !draft.lead || !draft.worker || JSON.stringify(draft) === JSON.stringify(state.pair)} onClick={() => { void save() }}>{saving ? tr(lang, '正在保存…', 'Saving…') : tr(lang, '保存组合', 'Save pair')}</button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <p>{tr(lang, '输出参数跟随原生模型设置，Fusion 不额外限制请求次数或任务轮数。', 'Output settings follow the native model settings; Fusion adds no request or round limits.')}</p>
      <p>{tr(lang, '保存即表示允许 Fusion 使用所选模型的现有账号；费用由这些账号计入，当前未提供可靠的实际账单金额。', 'Saving lets Fusion use the chosen models\' existing accounts; they are billed there, and no reliable billed amount is available here.')}</p>
      {state.pair && !state.authorized && <p role="status">{tr(lang, '组合需要重新保存后才能使用', 'Save the pair again before use')}{state.reason ? `: ${state.reason}` : ''}</p>}
      {state.managedAuthorization && <p>{tr(lang, '运行额度由外部授权配置管理。', 'Run limits are managed by an external authorization file.')}</p>}
    </>}
    <FusionCache refresh={state?.revision ?? 0} />
    <FusionHistory />
  </div>
}
