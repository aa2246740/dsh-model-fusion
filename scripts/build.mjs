import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'tsdown'
import { satisfies } from 'semver'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adapter = resolve(root, 'tools/client-build.js')
if (!existsSync(adapter)) throw new Error(`Missing vendored client build adapter: ${adapter}`)

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const dshRange = manifest.engines?.dsh
const host = process.env.DSHX_HARNESS
if (host) {
  const profilePath = resolve(host, 'packages/core/agent/package.json')
  if (!existsSync(profilePath)) throw new Error(`DSHX_HARNESS does not look like a Harness checkout: missing ${profilePath}`)
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  if (!dshRange || !satisfies(profile.version, dshRange, { includePrerelease: true })) {
    throw new Error(`Unsupported Host package version ${profile.version}; Fusion targets ${dshRange}`)
  }
}

const { externalClientBundle } = await import(pathToFileURL(adapter).href)

rmSync(resolve(root, 'lib/types'), { recursive: true, force: true })
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
mkdirSync(resolve(root, 'lib'), { recursive: true })

for (const config of externalClientBundle('dsh-model-fusion', ['src/dsh-model-fusion.ts'], { packageRoot: root, clientEntry: 'src/client/index.ts' })) {
  await build({ ...config, config: false, cwd: root })
}
