import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.host.config.mts'
const saviour = process.env.DSHX_COMPACT_SAVIOUR
if (!saviour) throw new Error('Set DSHX_COMPACT_SAVIOUR to the external plugin source under test')
export default defineConfig({ ...base, resolve: { alias: [
  { find: '@fusion-compat/controller', replacement: resolve(saviour, 'src/controller.ts') },
  { find: '@fusion-compat/routes', replacement: resolve(saviour, 'src/routes.ts') },
  { find: '@fusion-compat/model-selection', replacement: resolve(process.env.DSHX_HARNESS!, 'packages/api/session-controller/src/model-selection-projection.ts') },
  ...(base.resolve?.alias as any[] ?? []),
] }, test: { ...base.test, include: ['compat-tests/session-routing.spec.ts'] } })
