const listeners = new Set<() => void>()
export const onSettingsChanged = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const settingsChanged = (): void => { for (const listener of listeners) listener() }
