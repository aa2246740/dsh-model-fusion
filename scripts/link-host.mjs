import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'

// Development-only links. Published artifacts depend on the Host's public packages.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const supplied = process.env.DSH_REPO || process.argv[2]
if (!supplied) throw new Error('Usage: DSH_REPO=/absolute/path/to/harness node scripts/link-host.mjs')
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
const declared = new Map()
for (const section of ['peerDependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(own[section] ?? {})) {
    if (!name.startsWith('@deepseek-ai/') || name === '@deepseek-ai/dsh-invariants') continue
    if (!declared.has(name)) declared.set(name, range)
  }
}
function builtEntry(dir) {
  if (!existsSync(join(dir, 'package.json'))) return undefined
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? (typeof manifest.exports?.['.'] === 'string' ? manifest.exports['.'] : undefined) ?? manifest.main
  if (typeof entry === 'string' && !existsSync(join(dir, entry))) return undefined
  return { path: dir, version: manifest.version }
}
function runtimePackage(name) {
  const linked = join(host, 'node_modules', name)
  const direct = builtEntry(linked)
  if (direct) return direct
  let modules = join(host, 'node_modules')
  if (existsSync(join(host, 'node_modules/@deepseek-ai'))) {
    try { modules = dirname(realpathSync(join(host, 'node_modules/@deepseek-ai'))) } catch {}
  }
  const ignored = builtEntry(join(modules, '.ignored', name))
  if (ignored) return ignored
  const store = join(modules, '.pnpm')
  if (!existsSync(store)) return undefined
  const slug = name.replace('/', '+') + '@'
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(slug)) continue
    const found = builtEntry(join(store, entry, 'node_modules', name))
    if (found) return found
  }
  return undefined
}
const links = [...declared].map(([name, range]) => {
  const source = packages.get(name)
  const item = (source && builtEntry(source.path)) || runtimePackage(name)
  // DSH admits 0.2.2-rc.* through includePrerelease while rejecting 0.2.3-alpha.*
  // via the `<0.2.3-0` upper bound. Cordis keeps plain semver so prereleases
  // such as 4.2.0-rc.1 still fail ^4.1.0.
  const options = name.startsWith('@deepseek-ai/dsh') ? { includePrerelease: true } : undefined
  if (!item || !satisfies(item.version, range, options)) {
    throw new Error(`Host package/version mismatch: ${name} expected ${range}, found ${item?.version ?? 'missing'}`)
  }
  return { name, target: item.path }
}).filter(Boolean)
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
for (const { name, target } of links) {
  const link = join(root, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  try {
    const existing = lstatSync(link)
    if (realpathSync(link) === realpathSync(target)) continue
    if (!existing.isSymbolicLink() && !(process.platform === 'win32' && existing.isDirectory() && realpathSync(link) !== link)) {
      throw new Error(`Refusing to replace non-link ${link}`)
    }
    if (existing.isSymbolicLink()) unlinkSync(link)
    else rmSync(link) // a directory junction: removes the junction, never its target
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  symlinkSync(target, link, linkType)
}
console.log(`Linked ${links.length} version-checked public Host packages for development${linkType === 'junction' ? ' (directory junctions)' : ''}.`)
