import { resolve } from 'node:path'
import type { InlineConfig } from 'vite'
import { angular } from '@oxc-angular/vite'
import type { ResolvedBuildOptions } from './workspace.js'
import { htmlInjectPlugin, assetCopyPlugin } from './plugins.js'

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
    cssPreprocessorOptions.scss = { includePaths: paths }
    cssPreprocessorOptions.sass = { includePaths: paths }
    cssPreprocessorOptions.less = { paths }
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
      }),
      assetCopyPlugin(opts.assets, workspaceRoot, sourceRoot),
    ],

    // Global constant replacements (angular.json "define")
    ...(Object.keys(opts.define).length ? { define: opts.define } : {}),

    resolve: {
      preserveSymlinks: opts.preserveSymlinks,
    },

    css: Object.keys(cssPreprocessorOptions).length
      ? { preprocessorOptions: cssPreprocessorOptions }
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
    },
  }
}
