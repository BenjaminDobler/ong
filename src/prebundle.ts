import { resolve, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { build, type InlineConfig } from 'vite'
import { angular } from '@oxc-angular/vite'
import type { ResolvedBuildOptions } from './workspace.js'
import { resolveTsconfigPaths } from './config.js'
import { c } from './log.js'

interface LocalLib {
  /** The alias find pattern (e.g. "@flow-motion-nx/flow-motion") */
  find: string
  /** Absolute path to the lib entry (e.g. "/workspace/libs/flow-motion/src/index.ts") */
  entry: string
  /** Safe filename for the bundled output */
  fileName: string
}

/**
 * Pre-bundles local workspace libraries using rolldown + OXC.
 * This resolves circular dependencies within libs by bundling each
 * into a single ESM file before the Vite dev server starts.
 */
export async function prebundleLibs(
  viteConfig: InlineConfig,
  opts: ResolvedBuildOptions,
): Promise<InlineConfig> {
  const aliases = resolveTsconfigPaths(opts.tsconfig, opts.workspaceRoot)

  // Find aliases pointing to local workspace files (not node_modules)
  const localLibs: LocalLib[] = []
  for (const alias of aliases) {
    // Only handle exact-match aliases (string find), not wildcards (RegExp)
    if (typeof alias.find !== 'string') continue
    const target = alias.replacement
    // Must be inside workspace and not in node_modules
    if (!target.startsWith(opts.workspaceRoot)) continue
    if (target.includes('node_modules')) continue

    localLibs.push({
      find: alias.find,
      entry: target,
      fileName: alias.find.replace(/[@/]/g, '_').replace(/^_+/, ''),
    })
  }

  if (localLibs.length === 0) return viteConfig

  const start = Date.now()
  console.log(`  ${c.cyan}Pre-bundling ${localLibs.length} local lib${localLibs.length > 1 ? 's' : ''}...${c.reset}`)

  // Output inside workspace node_modules so Vite can resolve bare imports
  const tempDir = join(opts.workspaceRoot, 'node_modules', '.ong-prebundle')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  // Bundle each lib in parallel
  const results = await Promise.allSettled(
    localLibs.map(lib => bundleLib(lib, tempDir, aliases, opts, viteConfig))
  )

  // Collect successfully bundled libs
  const bundled = new Map<string, string>()
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      bundled.set(localLibs[i].find, join(tempDir, `${localLibs[i].fileName}.mjs`))
    } else {
      console.log(`  ${c.yellow}Warning: failed to pre-bundle ${localLibs[i].find}${c.reset}`)
      console.log(`  ${c.dim}${result.reason?.message ?? result.reason}${c.reset}`)
    }
  })

  if (bundled.size === 0) return viteConfig

  const duration = Date.now() - start
  const names = [...bundled.keys()].join(', ')
  console.log(`  ${c.green}Pre-bundled in ${duration}ms:${c.reset} ${c.dim}${names}${c.reset}`)
  console.log()

  // Rewrite aliases: bundled libs point to the temp output
  const newAliases = aliases.map(alias => {
    if (typeof alias.find === 'string' && bundled.has(alias.find)) {
      return { find: alias.find, replacement: bundled.get(alias.find)! }
    }
    return alias
  })

  return {
    ...viteConfig,
    resolve: {
      ...(viteConfig.resolve ?? {}),
      alias: newAliases,
    },
  }
}

async function bundleLib(
  lib: LocalLib,
  outDir: string,
  allAliases: { find: string | RegExp; replacement: string }[],
  opts: ResolvedBuildOptions,
  parentConfig: InlineConfig,
) {
  await build({
    configFile: false,
    root: opts.workspaceRoot,
    logLevel: 'warn',

    plugins: [
      ...angular({
        tsconfig: opts.tsconfig,
        sourceMap: opts.sourceMap,
        workspaceRoot: opts.workspaceRoot,
      }),
    ],

    resolve: {
      // All tsconfig aliases so inter-lib imports resolve
      alias: allAliases,
    },

    // Pass through same CSS config for SCSS/Less resolution
    css: parentConfig.css,

    build: {
      lib: {
        entry: lib.entry,
        formats: ['es'],
        fileName: lib.fileName,
      },
      outDir,
      emptyOutDir: false,
      sourcemap: opts.sourceMap,
      minify: false,
      rollupOptions: {
        external: (id: string) => {
          // Bundle relative/absolute imports (internal to the lib)
          if (id.startsWith('.') || id.startsWith('/')) return false
          // Externalize everything else (npm packages, other local lib aliases)
          return true
        },
      },
    },
  })
}
