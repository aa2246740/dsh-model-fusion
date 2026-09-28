import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(version = '4.0.4') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fusion-link-host-')))
  roots.push(root)
  const plugin = join(root, 'plugin'), host = join(root, 'host'), target = join(host, 'vendor/cordis')
  const write = (path: string, contents: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents) }
  write(join(plugin, 'package.json'), JSON.stringify({ type: 'module', peerDependencies: { '@deepseek-ai/cordis': '^4.0.4' } }))
  write(join(host, 'apps/cli/src/bin.ts'), '')
  mkdirSync(join(host, 'packages'))
  write(join(target, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version, main: 'lib/index.js' }))
  write(join(target, 'lib/index.js'), 'export const untouched = true\n')
  mkdirSync(join(plugin, 'scripts'))
  copyFileSync(resolve('scripts/link-host.mjs'), join(plugin, 'scripts/link-host.mjs'))
  mkdirSync(join(plugin, 'node_modules'))
  symlinkSync(realpathSync(resolve('node_modules/semver')), join(plugin, 'node_modules/semver'), process.platform === 'win32' ? 'junction' : 'dir')
  const link = join(plugin, 'node_modules/@deepseek-ai/cordis')
  const run = () => execFileSync(process.execPath, [join(plugin, 'scripts/link-host.mjs'), host], { encoding: 'utf8', stdio: 'pipe' })
  return { root, target, link, run }
}

describe('public Host development links', () => {
  it('accepts a compatible semver range and makes an idempotent native directory link', () => {
    const f = fixture()
    expect(f.run()).toContain('Linked 1 version-checked')
    expect(lstatSync(f.link).isSymbolicLink()).toBe(true)
    expect(realpathSync(f.link)).toBe(realpathSync(f.target))
    expect(f.run()).toContain('Linked 1 version-checked')
    expect(readFileSync(join(f.target, 'lib/index.js'), 'utf8')).toContain('untouched')
  })

  // '4.1.0-rc.1' must NOT satisfy '^4.0.4': prerelease versions need standard semver gating.
  it.each(['5.0.0', '4.1.0-rc.1'])('rejects incompatible packages before creating a link (%s)', version => {
    const f = fixture(version)
    expect(f.run).toThrow(/Host package\/version mismatch/)
    expect(existsSync(f.link)).toBe(false)
  })

  it('preserves a real installed directory instead of replacing its contents', () => {
    const f = fixture()
    mkdirSync(f.link, { recursive: true })
    writeFileSync(join(f.link, 'sentinel'), 'keep')
    expect(f.run).toThrow(/Refusing to replace non-link/)
    expect(readFileSync(join(f.link, 'sentinel'), 'utf8')).toBe('keep')
  })
})
