import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'

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
const peers = Object.entries(own.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
const skipped = []
const links = peers.map(([name, range]) => {
  const item = packages.get(name)
  if (!item || !satisfies(item.version, range)) {
    throw new Error(`Host package/version mismatch: ${name} expected ${range}, found ${item?.version ?? 'missing'}`)
  }
  // A source checkout only replaces the installed package once its public entry
  // point (main/exports → lib/) exists; otherwise keep the published devDependency.
  const manifest = JSON.parse(readFileSync(join(item.path, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']?.import ?? manifest.exports?.['.']?.default ?? manifest.main
  if (typeof entry === 'string' && !existsSync(join(item.path, entry))) { skipped.push(name); return undefined }
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
if (skipped.length) console.log(`Kept installed packages for ${skipped.length} Host peers whose checkout has no built entry point yet (build the Host or rely on the published devDependency): ${skipped.join(', ')}`)
