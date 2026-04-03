import { existsSync, cpSync, mkdirSync, readdirSync, createReadStream, readFileSync } from 'node:fs'
import { resolve, relative, join, extname } from 'node:path'
import type { Plugin } from 'vite'
import type { ResolvedBuildOptions, AssetConfig } from './workspace.js'
// Lazy-loaded from @oxc-angular/vite native binding (ESM-only export)
let _compileForHmrSync: ((template: string, className: string, filePath: string, styles: string[] | null, options: Record<string, any>) => { hmrModule: string }) | null = null
async function getCompileForHmrSync() {
  if (!_compileForHmrSync) {
    const oxc = await import('@oxc-angular/vite/api')
    _compileForHmrSync = (oxc as any).compileForHmrSync
  }
  return _compileForHmrSync!
}

const TEMPLATE_RE = /template\s*:\s*`([\s\S]*?)`/
const ANGULAR_COMPONENT_PREFIX = '@ng/component'

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
 * Fixes OXC HMR issues for Angular components:
 *
 * 1. External template/style changes trigger handleHotUpdate for the owning .ts
 *    file (via Vite's module dependency tracking), and OXC's handleHotUpdate
 *    sends a full-reload for any component .ts change. This plugin suppresses
 *    that spurious full-reload.
 *
 * 2. Inline template HMR: when a .ts file changes and only the template: `...`
 *    portion differs, route it through OXC's component HMR mechanism instead
 *    of doing a full page reload.
 *
 * Note: Vite module graph invalidation (stale transform cache on full reload)
 * is now handled by OXC itself since @oxc-angular/vite 0.0.19 (PR #158).
 *
 * IMPORTANT: This plugin must be placed BEFORE the angular() plugins in the
 * Vite plugin array so its handleHotUpdate runs first.
 */
export function hmrFixPlugin(): Plugin {
  // Track component files that just received a template/style HMR update
  const recentHmrUpdates = new Set<string>()
  // Track inline template HMR updates pending our middleware to serve
  const pendingInlineHmr = new Set<string>()
  // Cache inline template content and component class name per .ts file
  const inlineTemplateCache = new Map<string, { template: string; className: string }>()

  return {
    name: 'ong:hmr-fix',
    enforce: 'pre',
    // Cache inline template content during transform so we can detect template-only changes
    transform: {
      order: 'pre' as const,
      filter: { id: /\.tsx?/ },
      handler(code: string, id: string) {
        if (id.includes('node_modules')) return null
        if (!code.includes('@Component')) return null
        const cleanId = id.replace(/\?.*$/, '')
        const tmplMatch = code.match(TEMPLATE_RE)
        if (tmplMatch) {
          const classMatch = code.match(/(?:export\s+)?class\s+(\w+)/)
          inlineTemplateCache.set(cleanId, {
            template: tmplMatch[1],
            className: classMatch?.[1] || 'Component',
          })
        }
        return null
      },
    },
    configureServer(server) {
      // Middleware to serve inline template HMR updates.
      // Runs BEFORE OXC's middleware — intercepts requests for components
      // that have a pending inline template HMR update and compiles the
      // HMR module using OXC's compileForHmrSync.
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (!req.url?.includes(ANGULAR_COMPONENT_PREFIX)) return next()
        const requestUrl = new URL(req.url, 'http://localhost')
        const componentId = requestUrl.searchParams.get('c')
        if (!componentId) return next()
        const decoded = decodeURIComponent(componentId)
        const atIndex = decoded.indexOf('@')
        if (atIndex === -1) return next()
        const fileId = decoded.slice(0, atIndex)
        if (!pendingInlineHmr.has(fileId)) return next()
        pendingInlineHmr.delete(fileId)

        try {
          const resolvedId = resolve(process.cwd(), fileId)
          const source = readFileSync(resolvedId, 'utf-8')
          const tmplMatch = source.match(TEMPLATE_RE)
          if (!tmplMatch) return next()

          const cached = inlineTemplateCache.get(fileId)
          const className = cached?.className || 'Component'
          const templateContent = tmplMatch[1]

          const compile = await getCompileForHmrSync()
          const result = compile(templateContent, className, resolvedId, null, {})
          res.setHeader('Content-Type', 'text/javascript')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(result.hmrModule)
        } catch (e) {
          console.warn('[ong:hmr-fix] inline template HMR compile failed:', (e as Error).message)
          next()
        }
      })

      const origSend = server.ws.send.bind(server.ws)
      server.ws.send = (...args: any[]) => {
        const data = args[0]
        // Suppress full-reload for components that just had a template/style HMR update.
        if (data?.type === 'full-reload' && typeof data?.path === 'string' && recentHmrUpdates.has(data.path)) {
          return // suppress — HMR already handled the template/style change
        }
        const result = (origSend as any)(...args)
        if (data?.event === 'angular:component-update' && data?.data?.id) {
          const componentId = decodeURIComponent(data.data.id)
          const atIndex = componentId.indexOf('@')
          const filePath = atIndex !== -1 ? componentId.slice(0, atIndex) : componentId

          // Track this component so ws.send can suppress OXC's spurious full-reload
          recentHmrUpdates.add(filePath)
          setTimeout(() => recentHmrUpdates.delete(filePath), 2000)
        }
        return result
      }
    },
    handleHotUpdate(ctx) {
      // Suppress handleHotUpdate for files that just had an HMR update
      // (external template/style change triggered module graph invalidation)
      if (/\.tsx?$/.test(ctx.file) && recentHmrUpdates.has(ctx.file)) {
        return []
      }

      // Inline template HMR: detect template-only changes in .ts component files
      if (/\.tsx?$/.test(ctx.file) && inlineTemplateCache.has(ctx.file)) {
        const cached = inlineTemplateCache.get(ctx.file)!
        let newContent: string
        try {
          newContent = readFileSync(ctx.file, 'utf-8')
        } catch {
          return // can't read — let default handling proceed
        }
        const newTmplMatch = newContent.match(TEMPLATE_RE)
        if (!newTmplMatch) return // template removed or not found — full reload

        const newTemplate = newTmplMatch[1]
        if (newTemplate === cached.template) return // nothing changed

        // Check if ONLY the template changed by comparing the rest
        const newWithout = newContent.replace(TEMPLATE_RE, 'template: ``')
        const oldReconstructed = newContent.replace(newTmplMatch[1], cached.template)
          .replace(TEMPLATE_RE, 'template: ``')

        if (newWithout !== oldReconstructed) return // non-template code also changed — full reload

        // Template-only change! Route through component HMR.
        const componentId = `${ctx.file}@${cached.className}`
        const encodedId = encodeURIComponent(componentId)

        // Update cache with new template
        inlineTemplateCache.set(ctx.file, { template: newTemplate, className: cached.className })

        // Mark for our middleware to serve the HMR module
        pendingInlineHmr.add(ctx.file)
        setTimeout(() => pendingInlineHmr.delete(ctx.file), 5000)

        // Mark as recent HMR to suppress OXC's spurious full-reload
        recentHmrUpdates.add(ctx.file)
        setTimeout(() => recentHmrUpdates.delete(ctx.file), 2000)

        // Invalidate Vite's module graph so re-transform picks up the new template
        const mod = ctx.server.moduleGraph.getModuleById(ctx.file)
        if (mod) {
          ctx.server.moduleGraph.invalidateModule(mod)
        }

        // Send the same HMR event that OXC uses for external template changes
        ctx.server.ws.send({
          type: 'custom',
          event: 'angular:component-update',
          data: { id: encodedId, timestamp: Date.now() },
        })

        return [] // prevent default handling
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
