import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.DSHX_HARNESS
if (!host) throw new Error('Set DSHX_HARNESS to the explicit checkout used for this build')
const adapter = resolve(host, 'tools/dshx/src/client-build.js')
if (!existsSync(adapter)) throw new Error(`Missing dshx client build adapter: ${adapter}`)
const require = createRequire(resolve(host, 'package.json'))
const bundlerPath = require.resolve('tsdown')
const { build } = await import(pathToFileURL(bundlerPath).href)
const { externalClientBundle } = await import(pathToFileURL(adapter).href)
const profile = JSON.parse(readFileSync(resolve(host, 'packages/core/agent/package.json'), 'utf8'))
if (profile.version !== '0.2.0-rc.1') throw new Error(`Unsupported Host package version ${profile.version}`)
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
mkdirSync(resolve(root, 'lib'), { recursive: true })
for (const config of externalClientBundle('dsh-model-fusion', ['src/dsh-model-fusion.ts'], { packageRoot: root, clientEntry: 'src/client/index.ts' })) {
  await build({ ...config, config: false, cwd: root })
}
