import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
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

// A source checkout has no native binary until built. Accept the identical published
// native package as a test prerequisite, including in the crash-test child process.
const native = process.env.DSHX_NATIVE_SYSTEM
const nativeAliases: { find: string; replacement: string }[] = []
if (native) {
  const installed = JSON.parse(readFileSync(resolve(native, 'package.json'), 'utf8'))
  const expected = JSON.parse(readFileSync(resolve(host, 'native/system/packages/entry/package.json'), 'utf8'))
  if (installed.name !== expected.name || installed.version !== expected.version) throw new Error('Native system test package must match the pinned Host version')
  nativeAliases.push(
    { find: '@deepseek-ai/node-addon-system/flock', replacement: resolve(native, 'lib/flock.js') },
    { find: '@deepseek-ai/node-addon-system/landlock-run', replacement: resolve(native, 'lib/index.js') },
  )
}


export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: [
    ...nativeAliases,
    { find: '@fusion-host-test/mock-adapter', replacement: resolve(host, 'packages/core/agent-loop/tests/mock-adapter.ts') },
    { find: '@fusion-host-test/session-query', replacement: resolve(host, 'packages/subagent/subagent/tests/test-session-query.ts') },
    ...aliases,
  ] },
  test: { include: ['native-tests/**/*.spec.ts'], execArgv: vitestExecArgv, testTimeout: 15_000 },
})
