import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Development-only links. Published artifacts depend on the Host's public packages.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const supplied = process.argv[2]
if (!supplied) throw new Error('Usage: node scripts/link-host.mjs /absolute/path/to/harness')
const host = realpathSync(supplied)
if (!existsSync(join(host, 'apps/cli/src/bin.ts'))) throw new Error('Not a Harness checkout')
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packages = new Map()
function scan(path, depth) {
  if (existsSync(join(path, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    if (pkg.name) packages.set(pkg.name, { path, version: pkg.version })
    return
  }
  if (!depth) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') scan(join(path, entry.name), depth - 1)
  }
}
scan(join(host, 'packages'), 4)
scan(join(host, 'vendor'), 4)
const links = Object.entries(own.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/')).map(([name, version]) => {
  const item = packages.get(name)
  if (!item || item.version !== version) throw new Error(`Host package/version mismatch: ${name} expected ${version}, found ${item?.version ?? 'missing'}`)
  return { name, target: item.path }
})
for (const { name, target } of links) {
  const link = join(root, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  try {
    const existing = lstatSync(link)
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace non-link ${link}`)
    if (realpathSync(link) === realpathSync(target)) continue
    unlinkSync(link)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  symlinkSync(target, link, 'dir')
}
console.log(`Linked ${links.length} version-checked public Host packages for development.`)
