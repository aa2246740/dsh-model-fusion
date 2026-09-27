import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-model-fusion': { kind: 'plugin:dsh-model-fusion' } & ContextFormed
  }
}
