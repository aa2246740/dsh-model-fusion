// externalClientBundle — recreated from packages/client/tsdown.client.ts (DSH 0.2.2-rc.5).
// Harness 0.2.2 removed tools/dshx; this vendored recipe builds both the Node
// host entry and browser client factory bundle standalone without a Harness checkout.
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

// Official packages/client/tsdown.client.ts rules at dsh-v0.2.2-rc.5.
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|fs-patch|session|llm|tools|brand|official-bundles|deque|output-retention|typert-protocol|util-crypto|util-time|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-util-file-drag$|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-commands\/builtin$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-spill-policy\/notice$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(?:(?:cosmokit|schemastery)(?:\/|$)|cordis-plugin-timer$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const CSS_VIRTUAL_PREFIX = '\0dshx-css-module:'

function clientBuildValueDefines(environment) {
  const values = {}
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith('DSH_CLIENT_') || value === undefined) continue
    values[`process.env.${name}`] = JSON.stringify(value)
  }
  return values
}

function packageRelativePosix(packageRoot, fileId) {
  const absolute = isAbsolute(fileId) ? fileId : join(packageRoot, ...String(fileId).split('/'))
  const rel = relative(packageRoot, absolute)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`CSS module is outside the package root: ${fileId}`)
  }
  return rel.split(sep).join('/')
}

function cssModuleFile(packageRoot, fileRef) {
  const absolute = isAbsolute(fileRef) ? fileRef : join(packageRoot, ...String(fileRef).split('/'))
  return { absolute, logical: packageRelativePosix(packageRoot, absolute) }
}

const _lightningCache = new Map()
async function lightning(packageRoot) {
  if (!_lightningCache.has(packageRoot)) {
    const req = createRequire(join(packageRoot, 'package.json'))
    _lightningCache.set(packageRoot, await import(pathToFileURL(req.resolve('lightningcss')).href))
  }
  return _lightningCache.get(packageRoot)
}

function styleInjectionModule(id, fileId, css, classMap) {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

function pluginExternals(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    const extras = manifest?.dsh?.client?.external ?? []
    return new Set([...PLATFORM_MODULES, ...extras])
  } catch {
    return new Set(PLATFORM_MODULES)
  }
}

function hostPortableOutputPlugin() {
  return {
    name: 'dsh-host-portable-output',
    generateBundle(_options, output) {
      for (const [fileName, chunk] of Object.entries(output)) {
        if (chunk.type !== 'chunk') continue
        const offenders = [
          ...chunk.code.matchAll(/from\s*["'](\.[^"']*\.ts)["']/g),
          ...chunk.code.matchAll(/from\s*["'](\.\.?\/[^"']*node_modules\/[^"']*)["']/g),
        ].map(match => match[1])
        if (offenders.length > 0) {
          this.error(
            `${fileName} contains non-portable relative specifiers: ${[...new Set(offenders)].join(', ')}. `
            + 'Relative imports must be bundled, not externalized.',
          )
        }
      }
    },
  }
}

function clientPortableOutputPlugin(packageRoot) {
  return {
    name: 'dsh-client-portable-output',
    generateBundle(_options, output) {
      const client = output['client.js']
      if (client?.type !== 'chunk') this.error('client.js was not emitted')
      const rootPosix = resolve(packageRoot).replaceAll('\\', '/').replace(/\/$/u, '')
      client.code = client.code.replace(
        /^([ \t]*\/\/(?:#region )? ?)\\0dshx-css-module:([^\r\n]*?)(\r?)$/gmu,
        (_match, prefix, rawPath, ending) => {
          let cssPath = rawPath.replaceAll('\\', '/')
          const rootPrefix = `${rootPosix}/`
          if (cssPath.startsWith(rootPrefix)) cssPath = cssPath.slice(rootPrefix.length)
          return `${prefix}\\0dshx-css-module:${cssPath}${ending}`
        },
      )
      if (/^[ \t]*\/\/(?:#region )? ?\\0dshx-css-module:(?:\/|[A-Za-z]:[\\/])/mu.test(client.code)) {
        this.error('client.js contains a non-portable CSS module path')
      }
    },
  }
}

function clientConfig(id, entry, packageRoot) {
  const externals = pluginExternals(packageRoot)
  const isRequested = specifier => externals.has(specifier)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    sourcemap: true,
    minify: { compress: false, mangle: false },
    clean: false,
    dts: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: specifier => !isRequested(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      ...clientBuildValueDefines(process.env),
    },
    plugins: [{
      name: 'dshx-client-bundle-purity',
      resolveId(source) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external — cross-plugin value imports are forbidden`,
        )
      },
    }, {
      name: 'dshx-css-modules-inline',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined && !isAbsolute(source) ? join(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + packageRelativePosix(packageRoot, abs) + '.mjs'
      },
      async load(virtualId) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileRef = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -'.mjs'.length)
        const { absolute: fileId, logical } = cssModuleFile(packageRoot, fileRef)
        this.addWatchFile?.(fileId)
        const source = await readFile(fileId)
        const { transform } = await lightning(packageRoot)
        const { code, exports: cssExports } = transform({
          filename: logical, code: source,
          cssModules: { pattern: '[hash]_[local]' }, minify: true,
          targets: { chrome: 120 << 16, safari: (16 << 16) | (4 << 8) },
        })
        const classMap = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, code.toString(), classMap)
      },
    }, clientPortableOutputPlugin(packageRoot)],
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: chunk =>
        `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},${chunk.isEntry ? '' : `\n\tchunk: ${JSON.stringify(chunk.fileName)},`}\n\tfactory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export function externalClientBundle(id, entries, { packageRoot = process.cwd(), clientEntry } = {}) {
  const configs = []
  if (entries.length > 0) {
    configs.push({
      name: id,
      entry: Object.fromEntries(entries.map(e => [basename(e).replace(/\.(ts|tsx|js|mjs)$/, ''), e])),
      outDir: 'lib',
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      sourcemap: false,
      clean: false,
      dts: false,
      define: clientBuildValueDefines(process.env),
      // `neverBundle: true` keeps bare npm/builtin specifiers external as written
      // while bundling all relative source modules (avoids tsdown 0.23 handing
      // resolved absolute paths to a predicate and externalizing `.ts` files).
      deps: { neverBundle: true },
      plugins: [hostPortableOutputPlugin()],
      outputOptions: { entryFileNames: '[name].js' },
    })
  }
  if (clientEntry !== undefined) {
    if (configs.length === 0) {
      configs.push({ name: `${id}/placeholder`, entry: {}, outDir: 'lib', format: 'esm', platform: 'node', dts: false, sourcemap: false, clean: false })
    }
    configs.push(clientConfig(id, clientEntry, packageRoot))
  }
  return configs
}
