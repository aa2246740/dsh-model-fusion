import { useEffect, useState } from 'react'
import { tr, useLang, type Lang } from './i18n.js'

type Mode = 'auto' | 'on' | 'off'
interface Totals { waits: number; waitHits: number; pings: number; pingHits: number; pingTokens: number; keptWarmTokens: number; resentTokens: number }
interface CacheModel {
  provider: string; model: string; role?: 'lead' | 'worker'
  mode: Mode; intervalSeconds: number
  modeSource: 'user' | 'pair' | 'role' | 'route' | 'family' | 'generic'
  intervalSource: 'user' | 'learned' | 'route' | 'family' | 'generic'
  setting: { mode?: Mode; intervalSeconds?: number }
  defaults: { mode: Mode; intervalSeconds: number; source: string
    family?: { label: string; lifetime: { zh: string; en: string }; discount: string; docs: string }
    route?: { label: string; reason: { zh: string; en: string } } }
  totals: Totals | null; learnedIntervalSeconds: number | null; suggestion: number | null
  recent: { gapSeconds: number; ping: boolean; hit: boolean }[]
}

const tokens = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value)
const minutes = (seconds: number) => seconds % 60 ? `${(seconds / 60).toFixed(1)} min` : `${seconds / 60} min`
const modeName = (lang: Lang, mode: Mode) => ({ auto: tr(lang, '自动', 'Auto'), on: tr(lang, '开启', 'On'), off: tr(lang, '关闭', 'Off') })[mode]

function modeSource(lang: Lang, row: CacheModel): string {
  switch (row.modeSource) {
    case 'user': return tr(lang, '你的设置', 'your setting')
    case 'pair': return tr(lang, '旧版组合设置', 'older pair setting')
    case 'role': return tr(lang, 'Sidekick 默认关闭（它很少长时间等待）', 'Sidekick default off (it rarely waits long)')
    case 'route': return `${row.defaults.route!.label}: ${lang === 'zh' ? row.defaults.route!.reason.zh : row.defaults.route!.reason.en}`
    case 'family': return tr(lang, `${row.defaults.family!.label} 官方默认`, `${row.defaults.family!.label} documented default`)
    default: return tr(lang, '通用默认', 'generic default')
  }
}
function intervalSource(lang: Lang, row: CacheModel): string {
  if (row.intervalSource === 'user') return tr(lang, '你的设置', 'your setting')
  if (row.intervalSource === 'learned') return tr(lang, '自动学习：保活多次未命中，已缩短', 'learned: pings kept missing, shortened')
  return tr(lang, '默认', 'default')
}

function ModelCard({ row, onSaved }: { row: CacheModel; onSaved(): void }) {
  const lang = useLang()
  const [interval, setInterval] = useState(String(row.setting.intervalSeconds ? row.setting.intervalSeconds / 60 : ''))
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setError(undefined)
    try {
      const response = await fetch('/api/model-fusion', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cache-setting', provider: row.provider, model: row.model, ...body }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? tr(lang, '保存失败', 'Save failed'))
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const t = row.totals
  const family = row.defaults.family
  return <div className="fusion-cache-model">
    <strong>{row.model}<small>{row.provider}{row.role ? ` · ${row.role === 'lead' ? 'Lead' : 'Sidekick'}` : ''}</small></strong>
    <p>{tr(lang, '现在', 'Now')}: <b>{modeName(lang, row.mode)}</b>{row.mode !== 'off' && <>{tr(lang, '，每 ', ', every ')}<b>{minutes(row.intervalSeconds)}</b>{tr(lang, ' 续一次', '')}</>}
      <small>{tr(lang, '开关来源', 'Mode')}: {modeSource(lang, row)} · {tr(lang, '间隔来源', 'Interval')}: {intervalSource(lang, row)}</small></p>
    {family && <p><small>{tr(lang, '官方文档', 'Documented')}: {lang === 'zh' ? family.lifetime.zh : family.lifetime.en}；{tr(lang, '缓存价约为全价', 'cached price ≈')} {family.discount} · <a href={family.docs} target="_blank" rel="noreferrer">{tr(lang, '来源', 'source')}</a></small></p>}
    <div className="fusion-cache-controls">
      <label>{tr(lang, '保活', 'Keepalive')}<select aria-label={`${row.model} keepalive`} disabled={busy} value={row.setting.mode ?? ''}
        onChange={event => { void save({ mode: event.target.value || null, intervalSeconds: row.setting.intervalSeconds ?? null }) }}>
        <option value="">{tr(lang, `默认（${modeName(lang, row.defaults.mode)}）`, `Default (${modeName(lang, row.defaults.mode)})`)}</option>
        <option value="auto">{tr(lang, '自动：该模型返回过缓存命中后才开启', 'Auto: only after this model reports cache hits')}</option>
        <option value="on">{tr(lang, '开启', 'On')}</option>
        <option value="off">{tr(lang, '关闭（按请求次数计费的套餐选这个）', 'Off (choose for plans billed per request)')}</option>
      </select></label>
      <label>{tr(lang, '间隔（分钟）', 'Interval (min)')}<input type="number" min="1" max="59" step="0.5" disabled={busy} value={interval}
        placeholder={String(+(row.intervalSeconds / 60).toFixed(2))} onChange={event => setInterval(event.target.value)}
        onBlur={() => { if (interval !== String(row.setting.intervalSeconds ? row.setting.intervalSeconds / 60 : ''))
          void save({ mode: row.setting.mode ?? null, intervalSeconds: interval ? Math.round(Number(interval) * 60) : null }) }} /></label>
      <button type="button" disabled={busy || (!row.setting.mode && !row.setting.intervalSeconds)} onClick={() => { setInterval(''); void save({ reset: true }) }}>{tr(lang, '恢复默认', 'Reset')}</button>
    </div>
    {row.suggestion && <p role="status">{tr(lang, `观察到等待 ${minutes(row.suggestion)} 以上缓存仍然命中，可以把间隔放宽到 ${minutes(row.suggestion)}（不会自动修改）。`,
      `Cache still hit after waits over ${minutes(row.suggestion)}; you can lengthen the interval to ${minutes(row.suggestion)} (not changed automatically).`)}</p>}
    {t ? <p>{tr(lang, '效果', 'Effect')}: {tr(lang, `等待后命中 ${t.waitHits}/${t.waits} 次`, `hit after ${t.waitHits}/${t.waits} waits`)}{t.waits ? ` (${Math.round(100 * t.waitHits / t.waits)}%)` : ''}；
      {tr(lang, ` 保活 ${t.pings} 次（${t.pingHits} 次命中，读取 ${tokens(t.pingTokens)} token，多为缓存价）；`, ` ${t.pings} pings (${t.pingHits} hit, ${tokens(t.pingTokens)} tokens read, mostly at cache price); `)}
      {tr(lang, ` 等待后仍从缓存读取 ${tokens(t.keptWarmTokens)} token，按全价重发 ${tokens(t.resentTokens)} token。`, ` after waits ${tokens(t.keptWarmTokens)} tokens served from cache, ${tokens(t.resentTokens)} resent at full price.`)}
      {t.pings >= 5 && t.pingHits / t.pings < 0.5 && <b>{tr(lang, ' 保活大多没命中，建议关闭或缩短间隔。', ' Most pings missed: turn it off or shorten the interval.')}</b>}</p>
      : <p>{tr(lang, '还没有数据：Lead 等待 Sidekick 之后才会产生记录。', 'No data yet: records appear after the Lead waits for the Sidekick.')}</p>}
    {!!row.recent.length && <p><small>{tr(lang, '最近', 'Recent')}: {row.recent.map((item, i) => <span key={i}>{item.ping ? '↻' : ''}{minutes(item.gapSeconds)}{item.hit ? ' ✓' : ' ✗'}{i < row.recent.length - 1 ? ' · ' : ''}</span>)}</small></p>}
    {error && <p role="alert">{error}</p>}
  </div>
}

/** Per-model cache keepalive: what applies and why, the documented default, and what was observed. */
export function FusionCache({ refresh }: { refresh: number }) {
  const lang = useLang()
  const [rows, setRows] = useState<CacheModel[]>(), [checked, setChecked] = useState<string>(), [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/model-fusion?view=cache', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then(async response => { if (!response.ok) throw new Error(tr(lang, '无法读取缓存设置', 'Cannot read cache settings')); return response.json() as Promise<{ checked: string; models: CacheModel[] }> })
      .then(value => { setRows(value.models); setChecked(value.checked) })
      .catch(reason => { if (!abort.signal.aborted) setError(String(reason)) })
    return () => abort.abort()
  }, [refresh, reload, lang])
  return <section className="fusion-cache" aria-label={tr(lang, '缓存保活', 'Cache keepalive')}>
    <h3>{tr(lang, '缓存保活', 'Cache keepalive')}</h3>
    <p>{tr(lang, 'Lead 等 Sidekick 干活时可能要等几分钟，模型的输入缓存过期后，下一次请求会按全价重读整段对话。保活在等待期间定时发一个只要 1 个 token 的小请求，让缓存不过期。默认值来自各家官方文档，每个模型都可以单独调整。',
      'While the Lead waits for the Sidekick, the model\'s prompt cache can expire and the next request re-reads the whole conversation at full price. Keepalive sends a 1-token request at intervals to keep it warm. Defaults come from each provider\'s documentation; every model can be adjusted.')}</p>
    {checked && <p><small>{tr(lang, `官方默认值核对日期：${checked}。`, `Documented defaults checked on ${checked}.`)}</small></p>}
    {error && <p role="alert">{error}</p>}
    {rows?.map(row => <ModelCard key={`${row.provider}/${row.model}/${row.setting.mode ?? ''}/${row.setting.intervalSeconds ?? ''}`} row={row} onSaved={() => setReload(value => value + 1)} />)}
  </section>
}
