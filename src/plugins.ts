import { existsSync, cpSync, mkdirSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import type { Plugin } from 'vite'
import type { ResolvedBuildOptions, AssetConfig } from './workspace.js'

/**
 * Injects global styles, scripts, polyfills, and the entry point into index.html.
 * This makes a standard Angular index.html work with Vite without modifications.
 */
export function htmlInjectPlugin(opts: ResolvedBuildOptions): Plugin {
  const viteRoot = resolve(opts.workspaceRoot, opts.sourceRoot)
  const browserAbs = resolve(opts.browser)
  const browserRelative = browserAbs.startsWith(viteRoot + '/') || browserAbs === viteRoot
    ? '/' + relative(viteRoot, browserAbs)
    : '/@fs' + browserAbs
  const styleRefs = opts.styles.map(s => {
    const abs = resolve(s)
    if (abs.startsWith(viteRoot + '/') || abs === viteRoot) {
      return '/' + relative(viteRoot, abs)
    }
    return '/@fs' + abs
  })

  // Scripts outside the Vite root can't use relative URLs — use /@fs/ absolute paths instead.
  // Vite serves these because server.fs.allow includes workspaceRoot.
  const scriptRefs = opts.scripts.map(s => {
    const abs = resolve(s)
    if (abs.startsWith(viteRoot + '/') || abs === viteRoot) {
      return '/' + relative(viteRoot, abs)
    }
    return '/@fs' + abs
  })
  const crossOriginAttr = opts.crossOrigin !== 'none'
    ? ` crossorigin="${opts.crossOrigin}"`
    : ''

  return {
    name: 'ong:html-inject',
    transformIndexHtml: {
      order: 'pre' as const,
      handler(html: string) {
        let result = html

        // Inject/update base href if not default
        if (opts.baseHref && opts.baseHref !== '/') {
          if (result.includes('<base href=')) {
            result = result.replace(/<base href="[^"]*">/, `<base href="${opts.baseHref}">`)
          } else {
            result = result.replace('<head>', `<head>\n  <base href="${opts.baseHref}">`)
          }
        }

        // Inject global stylesheets
        if (styleRefs.length) {
          const tags = styleRefs
            .map(s => `  <link rel="stylesheet" href="${s}"${crossOriginAttr}>`)
            .join('\n')
          result = result.replace('</head>', `${tags}\n</head>`)
        }

        // Inject global scripts (plain scripts, not modules — they may define globals like registerLanguage)
        if (scriptRefs.length) {
          const tags = scriptRefs
            .map(s => `  <script src="${s}"${crossOriginAttr}></script>`)
            .join('\n')
          result = result.replace('</head>', `${tags}\n</head>`)
        }

        // Inject polyfills before the entry point
        if (opts.polyfills.length) {
          const imports = opts.polyfills
            .map(p => {
              // Check if it's a file path (relative to workspace root or absolute)
              const resolved = resolve(opts.workspaceRoot, p)
              const isFile = p.startsWith('.') || p.startsWith('/') || existsSync(resolved)
              // Use absolute path for file imports so Vite can resolve them regardless of root
              return isFile ? `import '${resolved}';` : `import '${p}';`
            })
            .join('\n')
          result = result.replace(
            '</body>',
            `  <script type="module">\n${imports}\n</script>\n</body>`
          )
        }

        // Inject entry point if not already present
        const hasEntry = html.includes(`src="${browserRelative}"`) ||
          html.includes('src="/main.ts"') ||
          html.includes('src="main.ts"')
        if (!hasEntry) {
          result = result.replace(
            '</body>',
            `  <script type="module" src="${browserRelative}"${crossOriginAttr}></script>\n</body>`
          )
        }

        return result
      },
    },
  }
}

/**
 * Copies static assets from angular.json config to build output.
 */
export function assetCopyPlugin(
  assets: AssetConfig[],
  workspaceRoot: string,
  sourceRoot: string,
): Plugin {
  return {
    name: 'ong:assets',
    writeBundle(bundleOpts) {
      const outDir = bundleOpts.dir || resolve(workspaceRoot, 'dist')

      for (const asset of assets) {
        if (typeof asset === 'string') {
          const src = resolve(workspaceRoot, asset)
          if (existsSync(src)) {
            const dest = join(outDir, asset.replace(sourceRoot + '/', ''))
            cpSync(src, dest, { recursive: true })
          }
        } else if (asset?.input) {
          const inputDir = resolve(workspaceRoot, asset.input)
          if (existsSync(inputDir)) {
            const outputDir = join(outDir, asset.output || '')
            mkdirSync(outputDir, { recursive: true })
            cpSync(inputDir, outputDir, { recursive: true })
          }
        }
      }
    },
  }
}
