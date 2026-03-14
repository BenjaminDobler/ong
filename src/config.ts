import { resolve, dirname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { InlineConfig, Alias } from 'vite'
import { angular } from '@oxc-angular/vite'
import type { ResolvedBuildOptions } from './workspace.js'
import { htmlInjectPlugin, assetCopyPlugin } from './plugins.js'

/**
 * Parse a tsconfig JSON file, stripping comments and trailing commas.
 */
function parseTsconfig(filePath: string): any {
  const raw = readFileSync(filePath, 'utf-8')
  const stripped = raw
    // Remove single-line comments
    .replace(/\/\/.*$/gm, '')
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove trailing commas before } or ]
    .replace(/,\s*([\]}])/g, '$1')
  return JSON.parse(stripped)
}

/**
 * Reads tsconfig paths and converts them to Vite resolve aliases.
 * Follows tsconfig "extends" chain (including array extends) to find paths from base configs.
 */
export function resolveTsconfigPaths(tsconfig: string, workspaceRoot: string): Alias[] {
  const aliases: Alias[] = []

  try {
    // Collect configs from root of extends chain to the leaf (tsconfig.app.json)
    // Each entry stores the parsed config and the directory of the tsconfig file
    const configChain: { config: any; dir: string }[] = []
    const visited = new Set<string>()

    const walk = (configPath: string) => {
      const resolved = resolve(configPath)
      if (visited.has(resolved) || !existsSync(resolved)) return
      visited.add(resolved)

      const config = parseTsconfig(resolved)
      const dir = dirname(resolved)

      // Recurse into extends first (parents before children in the chain)
      if (config.extends) {
        const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends]
        for (const ext of extendsList) {
          let extPath = resolve(dir, ext)
          if (!extPath.endsWith('.json')) extPath += '.json'
          walk(extPath)
        }
      }

      configChain.push({ config, dir })
    }

    walk(tsconfig)

    // Resolve inherited values: earlier entries (parents) are overridden by later (children)
    let baseUrl: string | undefined
    let baseUrlDir = workspaceRoot
    let paths: Record<string, string[]> | undefined

    for (const { config, dir } of configChain) {
      const co = config.compilerOptions ?? {}
      if (co.baseUrl !== undefined) {
        baseUrl = co.baseUrl
        baseUrlDir = dir  // baseUrl is relative to the tsconfig that defines it
      }
      if (co.paths !== undefined) {
        paths = co.paths
      }
    }

    if (!paths) return aliases

    const baseDir = baseUrl !== undefined ? resolve(baseUrlDir, baseUrl) : workspaceRoot

    for (const [pattern, targets] of Object.entries(paths)) {
      if (!targets.length) continue
      const target = targets[0]

      if (pattern.endsWith('/*')) {
        // Wildcard mapping: "@scope/lib/*" -> "libs/lib/src/*"
        const prefix = pattern.slice(0, -2)
        const targetDir = resolve(baseDir, target.slice(0, -2))
        aliases.push({ find: new RegExp(`^${escapeRegex(prefix)}/(.*)`), replacement: `${targetDir}/$1` })
      } else {
        // Exact mapping: "@scope/lib" -> "libs/lib/src/index.ts"
        // Use RegExp with $ anchor so "@scope/lib" doesn't prefix-match "@scope/lib/sub"
        // (Vite string aliases do prefix matching, but tsconfig exact paths should only match exactly)
        aliases.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolve(baseDir, target) })
      }
    }
  } catch (err) {
    console.warn(`  Warning: failed to resolve tsconfig paths: ${(err as Error).message}`)
  }

  return aliases
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detect Angular version from the workspace's @angular/core package.json.
 */
function detectAngularVersion(workspaceRoot: string): { major: number; minor: number; patch: number } | undefined {
  try {
    const pkgPath = join(workspaceRoot, 'node_modules/@angular/core/package.json')
    if (!existsSync(pkgPath)) return undefined
    const { version } = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const [major, minor, patch] = version.split('.').map(Number)
    return { major, minor, patch }
  } catch {
    return undefined
  }
}

/**
 * Creates a Vite InlineConfig from resolved Angular build options.
 */
export function createViteConfig(opts: ResolvedBuildOptions): InlineConfig {
  const { workspaceRoot, sourceRoot } = opts

  // Output naming based on hashing config
  const hash = (scope: 'asset' | 'chunk') => {
    if (opts.outputHashing === 'all') return true
    if (opts.outputHashing === 'none') return false
    if (opts.outputHashing === 'media' && scope === 'asset') return true
    if (opts.outputHashing === 'bundles' && scope === 'chunk') return true
    return false
  }

  // namedChunks overrides hash-based naming for JS chunks
  const useChunkHash = !opts.namedChunks && hash('chunk')
  const assetNames = hash('asset') ? 'assets/[name]-[hash].[ext]' : 'assets/[name].[ext]'
  const chunkNames = useChunkHash ? 'assets/[name]-[hash].js' : 'assets/[name].js'
  const entryNames = useChunkHash ? '[name]-[hash].js' : '[name].js'

  // deployUrl takes precedence over baseHref for Vite's base
  const base = opts.deployUrl || opts.baseHref || '/'


  // Sass/Less includePaths → Vite css.preprocessorOptions
  const cssPreprocessorOptions: Record<string, any> = {}
  if (opts.stylePreprocessorOptions.includePaths.length) {
    const paths = opts.stylePreprocessorOptions.includePaths
    cssPreprocessorOptions.scss = { api: 'modern-compiler', loadPaths: paths }
    cssPreprocessorOptions.sass = { api: 'modern-compiler', loadPaths: paths }
    cssPreprocessorOptions.less = { paths }
  }

  // Auto-detect tailwind.config.js in the project directory and wire up PostCSS
  const projectDir = resolve(workspaceRoot, opts.sourceRoot, '..')
  const tailwindConfigPath = ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs']
    .map(f => join(projectDir, f))
    .find(existsSync)
  const postcssPlugins: Record<string, any> = {}
  if (tailwindConfigPath) {
    try {
      const require = createRequire(join(workspaceRoot, 'package.json'))
      const tailwindcss = require('tailwindcss')
      const autoprefixer = require('autoprefixer')
      postcssPlugins['tailwindcss'] = tailwindcss({ config: tailwindConfigPath })
      postcssPlugins['autoprefixer'] = autoprefixer()
    } catch (e) {
      console.warn('[ong] Tailwind PostCSS setup failed:', (e as Error).message)
    }
  }

  return {
    root: resolve(workspaceRoot, sourceRoot),
    base,
    publicDir: resolve(workspaceRoot, 'public'),
    logLevel: 'info',

    plugins: [
      htmlInjectPlugin(opts),
      ...angular({
        tsconfig: opts.tsconfig,
        sourceMap: opts.sourceMap,
        liveReload: !opts.optimization,
        workspaceRoot,
        ...(opts.fileReplacements.length ? { fileReplacements: opts.fileReplacements } : {}),
        angularVersion: detectAngularVersion(workspaceRoot),
      }),
      assetCopyPlugin(opts.assets, workspaceRoot, sourceRoot),
    ],

    // Global constant replacements (angular.json "define")
    ...(Object.keys(opts.define).length ? { define: opts.define } : {}),

    resolve: {
      preserveSymlinks: opts.preserveSymlinks,
      alias: resolveTsconfigPaths(opts.tsconfig, workspaceRoot),
    },

    css: (Object.keys(cssPreprocessorOptions).length || Object.keys(postcssPlugins).length)
      ? {
          preprocessorOptions: Object.keys(cssPreprocessorOptions).length ? cssPreprocessorOptions : undefined,
          postcss: Object.keys(postcssPlugins).length ? { plugins: Object.values(postcssPlugins) } : undefined,
        }
      : undefined,

    build: {
      outDir: opts.outputPath,
      emptyOutDir: true,
      sourcemap: opts.sourceMap,
      minify: opts.optimization ? 'oxc' : false,
      modulePreload: { polyfill: false },
      watch: opts.watch ? {} : null,
      rollupOptions: {
        // Use index.html as entry so Vite processes HTML transforms (script/style injection)
        input: resolve(workspaceRoot, sourceRoot, 'index.html'),
        external: opts.externalDependencies.length ? opts.externalDependencies : undefined,
      },
      assetsInlineLimit: 0,
      rolldownOptions: {
        tsconfig: opts.tsconfig,
        output: {
          assetFileNames: assetNames,
          chunkFileNames: chunkNames,
          entryFileNames: entryNames,
        },
      },
    },

    server: {
      port: opts.serve.port,
      open: opts.serve.open,
      host: opts.serve.host ?? false,
      watch: opts.poll ? { usePolling: true, interval: opts.poll } : undefined,
      fs: {
        allow: [workspaceRoot],
      },
    },
  }
}
