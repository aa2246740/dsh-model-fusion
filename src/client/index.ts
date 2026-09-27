import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { FusionSettings } from './FusionSettings.js'
import { FusionHint } from './FusionHint.js'
import { FusionTool, fusionControlTools } from './FusionTool.js'
import { bindLocale } from './i18n.js'

export const name = 'dsh-model-fusion/client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  // Follow DSH's language setting (Chinese or English) when the locale service is present.
  ctx.inject(['locale'], scope => { scope.effect(() => bindLocale((scope as unknown as { locale: Parameters<typeof bindLocale>[0] }).locale)) })
  for (const tool of fusionControlTools) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: tool,
  }, FusionTool))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fusion', order: 18, label: () => 'Fusion', inject: () => ({}),
  }, FusionSettings))
  ctx.inject(['modelDirectories'], scope => {
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: 'fusion-configuration', order: 20,
      inject: sessionId => {
        const directory = scope.modelDirectories.directoryFor(sessionId)
        return { sessionId, directory: directory.store, load: () => { void directory.load().catch(() => undefined) } }
      },
    }, FusionHint))
  })
}
