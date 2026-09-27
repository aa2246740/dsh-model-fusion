import { useSyncExternalStore } from 'react'

/** The DSH client locale service (`ctx.locale`), used by structure only. */
interface LocaleSource { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void }

let source: LocaleSource | undefined
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

/** Called from the client entry when DSH's locale service is available; follows the user's language setting. */
export function bindLocale(next: LocaleSource): () => void {
  source = next
  notify()
  const unsubscribe = next.subscribe(notify)
  return () => { unsubscribe(); if (source === next) { source = undefined; notify() } }
}

export type Lang = 'zh' | 'en'
const current = (): Lang => {
  const id = source?.getSnapshot().active ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)
  return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The UI language: Chinese for any zh locale, English otherwise (DSH's own fallback). */
export function useLang(): Lang {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, current, () => 'en')
}

/** Pick the text for the active language. */
export const tr = (lang: Lang, zh: string, en: string) => lang === 'zh' ? zh : en
