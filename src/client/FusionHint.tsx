import { tr, useLang } from './i18n.js'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { onSettingsChanged } from './settings-events.js'
import { FusionStatus } from './FusionStatus.js'

export interface FusionHintProps { sessionId: string; directory: ObservableSnapshot<ModelDirectoryState>; load(): void }

/** Additive composer hint. The original selector and its selection state stay native. */
export function FusionHint({ sessionId, directory, load }: FusionHintProps) {
  const selected = useSyncExternalStore(directory.subscribe, directory.getSnapshot).current
  const fusion = selected?.provider === 'dsh-model-fusion' && selected.model === 'auto'
  const lang = useLang()
  const [message, setMessage] = useState<string>()
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!fusion) { setMessage(undefined); return }
    let active = true
    const abort = new AbortController()
    const refresh = () => {
      void fetch('/api/model-fusion?view=settings', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
        .then(async response => { if (!response.ok) throw new Error('unavailable'); return response.json() as Promise<{ pair: unknown; authorized: boolean }> })
        .then(state => { if (active) setMessage(!state.pair ? tr(lang, 'Fusion 尚未配置模型，请前往设置 → Fusion 选择 Lead 和 Sidekick。', 'Fusion has no models yet: open Settings → Fusion and choose a Lead and a Sidekick.')
          : !state.authorized ? tr(lang, 'Fusion 当前配置未就绪，请前往设置 → Fusion 查看。', 'The Fusion setup is not ready: see Settings → Fusion.') : undefined) })
        .catch(() => { if (active) setMessage(tr(lang, '暂时无法确认 Fusion 配置，请前往设置 → Fusion 查看。', 'Cannot confirm the Fusion setup right now: see Settings → Fusion.')) })
    }
    refresh()
    const off = onSettingsChanged(refresh)
    return () => { active = false; abort.abort(); off() }
  }, [fusion, lang])
  if (!fusion) return null
  return <>
    {message && <p role="status" style={{ margin: '8px 12px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' }}>{message}</p>}
    <FusionStatus sessionId={sessionId} attentionOnly />
  </>
}
