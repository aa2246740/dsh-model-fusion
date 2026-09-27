import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const host = process.env.DSHX_HARNESS
if (!host) throw new Error('Native Host tests require DSHX_HARNESS pointing at the pinned checkout')
const parsed = ts.readConfigFile(resolve(host, 'tsconfig.base.json'), ts.sys.readFile)
if (parsed.error) throw new Error('Cannot read the Host source alias map')
const aliases = Object.entries(parsed.config.compilerOptions.paths as Record<string, string[]>).map(([name, paths]) => ({
  find: new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '(.*)')}$`),
  replacement: resolve(host, paths[0]!).replaceAll('*', '$1'),
}))
const { standardDecoratorPlugin, vitestExecArgv } = await import(pathToFileURL(resolve(host, 'vitest.shared.ts')).href)

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: [
    { find: '@fusion-host-test/mock-adapter', replacement: resolve(host, 'packages/core/agent-loop/tests/mock-adapter.ts') },
    { find: '@fusion-host-test/session-query', replacement: resolve(host, 'packages/subagent/subagent/tests/test-session-query.ts') },
    ...aliases,
  ] },
  test: { include: ['native-tests/**/*.spec.ts'], execArgv: vitestExecArgv, testTimeout: 15_000 },
})
