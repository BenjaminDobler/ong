import { join, dirname } from 'node:path'
import { mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { build, type InlineConfig } from 'vite'
import { angular } from '@oxc-angular/vite'
import type { ResolvedBuildOptions } from './workspace.js'
import { resolveTsconfigPaths, detectAngularVersion } from './config.js'
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
    const target = alias.replacement
    // Must be inside workspace and not in node_modules
    if (!target.startsWith(opts.workspaceRoot)) continue
    if (target.includes('node_modules')) continue

    let findName: string
    if (typeof alias.find === 'string') {
      findName = alias.find
    } else {
      // config.ts emits exact-match aliases as /^escaped-name$/ RegExp
      // Wildcards have a capture group — skip those, only handle exact matches
      const src = alias.find.source
      if (src.includes('(.*)')) continue
      // Strip ^ and $ anchors, unescape regex-escaped chars
      findName = src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1')
    }

    localLibs.push({
      find: findName,
      entry: target,
      fileName: findName.replace(/[@/]/g, '_').replace(/^_+/, ''),
    })
  }

  if (localLibs.length === 0) return viteConfig

  // Only bundle libs transitively imported by this app, not all workspace libs
  const toBundle = findTransitiveDeps(opts.sourceRoot, localLibs)
  const filteredLibs = localLibs.filter(l => toBundle.has(l.find))

  if (filteredLibs.length === 0) return viteConfig

  const start = Date.now()
  console.log(`  ${c.cyan}Pre-bundling ${filteredLibs.length} local lib${filteredLibs.length > 1 ? 's' : ''}...${c.reset}`)

  // Output inside workspace node_modules so Vite can resolve bare imports
  const tempDir = join(opts.workspaceRoot, 'node_modules', '.ong-prebundle')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  const angularVersion = detectAngularVersion(opts.workspaceRoot)

  // Bundle each lib in parallel
  const results = await Promise.allSettled(
    filteredLibs.map(lib => bundleLib(lib, tempDir, aliases, opts, viteConfig, angularVersion))
  )

  // Collect successfully bundled libs
  const bundled = new Map<string, string>()
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      bundled.set(filteredLibs[i].find, join(tempDir, `${filteredLibs[i].fileName}.mjs`))
    } else {
      const reason = result.reason
      console.log(`  ${c.yellow}Warning: failed to pre-bundle ${filteredLibs[i].find}${c.reset}`)
      console.log(`  ${c.dim}${reason?.message ?? reason}${c.reset}`)
      if (reason?.stack) {
        console.log(`  ${c.dim}${reason.stack}${c.reset}`)
      }
    }
  })

  if (bundled.size === 0) return viteConfig

  const duration = Date.now() - start
  const names = [...bundled.keys()].join(', ')
  console.log(`  ${c.green}Pre-bundled in ${duration}ms:${c.reset} ${c.dim}${names}${c.reset}`)
  console.log()

  // Rewrite aliases: bundled libs point to the temp output
  const newAliases = aliases.map(alias => {
    if (typeof alias.find === 'string') {
      if (bundled.has(alias.find)) {
        return { find: alias.find, replacement: bundled.get(alias.find)! }
      }
    } else {
      // Recover plain name from /^escaped-name$/ to check against bundled map
      const src = alias.find.source
      if (!src.includes('(.*)')) {
        const name = src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1')
        if (bundled.has(name)) {
          // Keep the RegExp find (exact match) — do NOT use a plain string, which would
          // do prefix matching in Vite and shadow wildcard aliases like @scope/lib/*
          return { find: alias.find, replacement: bundled.get(name)! }
        }
      }
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

/**
 * Scans all .ts files in a directory (recursively) and returns the names of any
 * local lib aliases imported. Skips spec and declaration files.
 */
function scanDirForLibImports(dir: string, libNames: Set<string>): Set<string> {
  const found = new Set<string>()
  if (!existsSync(dir)) return found

  const walk = (d: string) => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
        let content: string
        try { content = readFileSync(full, 'utf-8') } catch { continue }
        const re = /from\s+['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(content)) !== null) {
          if (libNames.has(m[1])) found.add(m[1])
        }
      }
    }
  }

  walk(dir)
  return found
}

/**
 * BFS from the app's source directory to find all local libs transitively imported.
 */
function findTransitiveDeps(appSrcDir: string, localLibs: LocalLib[]): Set<string> {
  const libNames = new Set(localLibs.map(l => l.find))
  const libByName = new Map(localLibs.map(l => [l.find, l]))
  const visited = new Set<string>()
  const queue: string[] = []

  for (const name of scanDirForLibImports(appSrcDir, libNames)) {
    if (!visited.has(name)) { visited.add(name); queue.push(name) }
  }

  while (queue.length > 0) {
    const name = queue.shift()!
    const lib = libByName.get(name)!
    for (const dep of scanDirForLibImports(dirname(lib.entry), libNames)) {
      if (!visited.has(dep)) { visited.add(dep); queue.push(dep) }
    }
  }

  return visited
}

/**
 * Vite plugin that rewrites `export { Foo }` / `export { Foo } from '...'`
 * to `export type { Foo }` when `Foo` is a TypeScript interface or type alias.
 * This prevents rolldown from throwing MISSING_EXPORT errors for type-only
 * symbols that OXC erases during compilation.
 */
export function typeExportFixPlugin(): import('vite').Plugin {
  let aliases: { find: string | RegExp; replacement: string }[] = []

  const resolveWithAliases = (importPath: string): string | null => {
    for (const alias of aliases) {
      if (typeof alias.find === 'string') {
        if (importPath === alias.find) return alias.replacement
        if (importPath.startsWith(alias.find + '/')) {
          return alias.replacement + importPath.slice(alias.find.length)
        }
      } else {
        const match = importPath.match(alias.find)
        if (match) {
          return match[1]
            ? alias.replacement.replace('$1', match[1])
            : alias.replacement
        }
      }
    }
    return null
  }

  const resolveFile = (base: string): string | null => {
    const candidates = [base, `${base}.ts`, `${base}/index.ts`]
    for (const c of candidates) {
      try { readFileSync(c, 'utf-8'); return c } catch { /* try next */ }
    }
    return null
  }

  const getTypeNamesDeep = (filePath: string, visited?: Set<string>): Set<string> => {
    if (!visited) visited = new Set()
    if (visited.has(filePath)) return new Set()
    visited.add(filePath)

    let src: string
    try { src = readFileSync(filePath, 'utf-8') } catch { return new Set() }

    const names = new Set<string>()
    // Match exported type/interface declarations — require 'export' keyword to avoid
    // matching `type Foo` inside import specifier lists
    for (const m of src.matchAll(/^\s*export\s+(?:interface|type)\s+(\w+)/gm)) {
      names.add(m[1])
    }

    // Follow `export * from '...'` to find types in re-exported modules
    for (const m of src.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
      const depPath = m[1]
      let resolved: string | null = null
      if (depPath.startsWith('.')) {
        resolved = resolveFile(join(dirname(filePath), depPath))
      } else {
        const aliasResolved = resolveWithAliases(depPath)
        if (aliasResolved) resolved = resolveFile(aliasResolved)
      }
      if (resolved) {
        for (const name of getTypeNamesDeep(resolved, visited)) {
          names.add(name)
        }
      }
    }

    // Follow `export { Foo } from '...'` — names listed here that are types in the source
    for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const exports = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      const depPath = m[2]
      let resolved: string | null = null
      if (depPath.startsWith('.')) {
        resolved = resolveFile(join(dirname(filePath), depPath))
      } else {
        const aliasResolved = resolveWithAliases(depPath)
        if (aliasResolved) resolved = resolveFile(aliasResolved)
      }
      if (resolved) {
        const deepNames = getTypeNamesDeep(resolved, visited)
        for (const name of exports) {
          if (deepNames.has(name)) names.add(name)
        }
      }
    }

    return names
  }

  const getValueNamesDeep = (filePath: string, visited?: Set<string>): Set<string> => {
    if (!visited) visited = new Set()
    if (visited.has(filePath)) return new Set()
    visited.add(filePath)

    let src: string
    try { src = readFileSync(filePath, 'utf-8') } catch { return new Set() }

    const names = new Set<string>()
    for (const m of src.matchAll(/^(?:export\s+)?(?:default\s+|abstract\s+|declare\s+)*(?:class|const|let|var|function|enum|namespace)\s+(\w+)/gm)) {
      names.add(m[1])
    }

    // Follow `export * from '...'`
    for (const m of src.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
      const depPath = m[1]
      let resolved: string | null = null
      if (depPath.startsWith('.')) {
        resolved = resolveFile(join(dirname(filePath), depPath))
      } else {
        const aliasResolved = resolveWithAliases(depPath)
        if (aliasResolved) resolved = resolveFile(aliasResolved)
      }
      if (resolved) {
        for (const name of getValueNamesDeep(resolved, visited)) {
          names.add(name)
        }
      }
    }

    // Follow `export { Foo } from '...'` — check if named exports are values in the source
    for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const exports = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      const depPath = m[2]
      let resolved: string | null = null
      if (depPath.startsWith('.')) {
        resolved = resolveFile(join(dirname(filePath), depPath))
      } else {
        const aliasResolved = resolveWithAliases(depPath)
        if (aliasResolved) resolved = resolveFile(aliasResolved)
      }
      if (resolved) {
        const deepNames = getValueNamesDeep(resolved, visited)
        for (const name of exports) {
          if (deepNames.has(name)) names.add(name)
        }
      }
    }

    return names
  }

  return {
    name: 'ong:type-export-fix',
    enforce: 'pre',
    configResolved(config) {
      aliases = (config.resolve?.alias as any[]) || []
    },
    transform(code, id) {
      if (!id.endsWith('.ts')) return null

      const getTypeNames = (src: string): Set<string> => {
        const names = new Set<string>()
        for (const m of src.matchAll(/^\s*export\s+(?:interface|type)\s+(\w+)/gm)) {
          names.add(m[1])
        }
        return names
      }

      // Names declared as interface/type in this file
      const localTypeNames = getTypeNames(code)

      let result = code

      // Rewrite `import { Foo } from '...'` → `import { type Foo } from '...'`
      // when Foo is a type in the source module. This ensures OXC elides the import
      // so the browser never asks for a non-existent export binding.
      result = result.replace(
        /\bimport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
        (match, inner: string, fromPath: string) => {
          if (match.includes('import type')) return match
          const dir = dirname(id)
          let basePath: string | null = fromPath.startsWith('.')
            ? join(dir, fromPath)
            : resolveWithAliases(fromPath)

          if (!basePath) return match
          const resolved = resolveFile(basePath)
          if (!resolved) return match

          const sourceTypeNames = getTypeNamesDeep(resolved)
          if (sourceTypeNames.size === 0) return match

          // Also get value names deeply to avoid false positives
          // (a name can be both a type and a value, e.g. class, enum, namespace)
          const sourceValueNames = getValueNamesDeep(resolved)

          let changed = false
          const parts = inner.split(',').map((s: string) => {
            const trimmed = s.trim()
            if (!trimmed || trimmed.startsWith('type ')) return s
            const name = trimmed.split(/\s+as\s+/)[0].trim()
            if (sourceTypeNames.has(name) && !sourceValueNames.has(name)) {
              changed = true
              return s.replace(trimmed, `type ${trimmed}`)
            }
            return s
          })

          return changed ? `import {${parts.join(',')}} from '${fromPath}'` : match
        }
      )

      // Rewrite `export { Foo } from '...'` → `export { type Foo } from '...'`
      result = result.replace(
        /\bexport\s*\{([^}]+)\}(\s*from\s*['"]([^'"]+)['"])?/g,
        (match, inner: string, fromClause: string | undefined, fromPath: string | undefined) => {
          let sourceTypeNames = localTypeNames
          if (fromPath) {
            const dir = dirname(id)
            let basePath: string | null = fromPath.startsWith('.')
              ? join(dir, fromPath)
              : resolveWithAliases(fromPath)

            if (basePath) {
              const resolved = resolveFile(basePath)
              if (resolved) {
                sourceTypeNames = getTypeNamesDeep(resolved)
              }
            }
          }

          if (sourceTypeNames.size === 0) return match

          const parts = inner.split(',').map((s: string) => {
            const trimmed = s.trim()
            if (!trimmed) return s
            const name = trimmed.split(/\s+as\s+/)[0].trim()
            if (sourceTypeNames.has(name) && !trimmed.startsWith('type ')) {
              return ` type ${trimmed}`
            }
            return s
          })

          const base = `export {${parts.join(',')}}`
          return fromClause ? `${base}${fromClause}` : base
        }
      )

      return result !== code ? { code: result, map: null } : null
    },
  }
}

async function bundleLib(
  lib: LocalLib,
  outDir: string,
  allAliases: { find: string | RegExp; replacement: string }[],
  opts: ResolvedBuildOptions,
  parentConfig: InlineConfig,
  angularVersion?: { major: number; minor: number; patch: number },
) {
  await build({
    configFile: false,
    root: dirname(lib.entry),
    logLevel: 'warn',

    plugins: [
      typeExportFixPlugin(),
      ...angular({
        tsconfig: opts.tsconfig,
        sourceMap: opts.sourceMap,
        workspaceRoot: opts.workspaceRoot,
        angularVersion,
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
