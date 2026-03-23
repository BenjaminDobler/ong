import { existsSync, cpSync, mkdirSync, readdirSync, createReadStream } from 'node:fs'
import { resolve, relative, join, extname } from 'node:path'
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

        // Enable Angular HMR in dev mode
        if (!opts.optimization) {
          result = result.replace('<head>', `<head>\n  <script>globalThis._enableHmr = true;</script>`)
        }

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

        // Inject custom HTML/scripts before </head> (e.g., dev tools, analytics, runtime instrumentation)
        if (opts.injectHtml) {
          result = result.replace('</head>', `${opts.injectHtml}\n</head>`)
        }

        return result
      },
    },
  }
}

/**
 * Fixes an OXC bug where template/style changes are not reflected after a full
 * page reload. OXC's custom fs.watch clears its own resourceCache but never
 * calls server.moduleGraph.invalidateModule(), so Vite's transform cache goes
 * stale. This plugin intercepts OXC's HMR WS event and defers module
 * invalidation so live HMR isn't disrupted while future full reloads pick up
 * the fresh transform.
 */
export function hmrFixPlugin(): Plugin {
  return {
    name: 'ong:hmr-fix',
    enforce: 'post',
    configureServer(server) {
      const origSend = server.ws.send.bind(server.ws)
      server.ws.send = (...args: any[]) => {
        // Send the HMR event first so OXC's live update isn't disrupted
        const result = (origSend as any)(...args)
        const data = args[0]
        if (data?.event === 'angular:component-update' && data?.data?.id) {
          // Defer module invalidation — only needed so future full reloads
          // pick up the new transform instead of serving stale cache
          setTimeout(() => {
            const componentId = decodeURIComponent(data.data.id)
            const atIndex = componentId.indexOf('@')
            const filePath = atIndex !== -1 ? componentId.slice(0, atIndex) : componentId
            const mod = server.moduleGraph.getModuleById(filePath)
            if (mod) {
              server.moduleGraph.invalidateModule(mod)
            }
          }, 50)
        }
        return result
      }
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

    // During dev, serve assets from their source input directories
    configureServer(server) {
      // Build a list of (urlPrefix → inputDir, glob) mappings for object-style assets
      const mappings: { urlPrefix: string; inputDir: string; glob: string }[] = []
      for (const asset of assets) {
        if (typeof asset === 'string' || !asset?.input) continue
        const inputDir = resolve(workspaceRoot, asset.input)
        const urlPrefix = '/' + (asset.output ?? '').replace(/^\//, '')
        mappings.push({ urlPrefix, inputDir, glob: asset.glob ?? '**/*' })
      }
      if (mappings.length === 0) return

      const globToRegex = (g: string) =>
        new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')

      const MIME: Record<string, string> = {
        '.json': 'application/json',
        '.jsonc': 'application/json',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      }

      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        for (const { urlPrefix, inputDir, glob } of mappings) {
          if (!url.startsWith(urlPrefix)) continue
          const rel = url.slice(urlPrefix.length).replace(/^\//, '')
          if (!rel) continue
          const re = globToRegex(glob)
          const fileName = rel.split('/').pop() ?? ''
          if (!re.test(fileName) && !re.test(rel)) continue
          const filePath = join(inputDir, rel)
          if (!existsSync(filePath)) continue
          const mime = MIME[extname(filePath)] ?? 'application/octet-stream'
          res.setHeader('Content-Type', mime)
          createReadStream(filePath).pipe(res)
          return
        }
        next()
      })
    },

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
            if (!asset.glob || asset.glob === '**/*') {
              // No glob filter — copy contents of inputDir into outputDir
              for (const entry of readdirSync(inputDir, { withFileTypes: true })) {
                cpSync(join(inputDir, entry.name), join(outputDir, entry.name), { recursive: true })
              }
            } else {
              // Glob filter — match files in inputDir against the pattern
              const globToRegex = (g: string) =>
                new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
              const re = globToRegex(asset.glob)
              const walk = (dir: string) => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                  const abs = join(dir, entry.name)
                  const rel = relative(inputDir, abs)
                  if (entry.isDirectory()) {
                    walk(abs)
                  } else if (re.test(entry.name) || re.test(rel)) {
                    const dest = join(outputDir, rel)
                    mkdirSync(resolve(dest, '..'), { recursive: true })
                    cpSync(abs, dest)
                  }
                }
              }
              walk(inputDir)
            }
          }
        }
      }
    },
  }
}
