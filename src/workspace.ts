import { readFileSync, existsSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'

// ═══════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════

export interface ResolvedBuildOptions {
  /** Absolute path to workspace root */
  workspaceRoot: string
  /** Project name */
  projectName: string
  /** Configuration name */
  configName: string
  /** Source root relative to workspace (e.g. "src" or "apps/my-app/src") */
  sourceRoot: string
  /** Absolute path to tsconfig */
  tsconfig: string
  /** Absolute path to browser entry (e.g. src/main.ts) */
  browser: string
  /** Absolute paths to global style files */
  styles: string[]
  /** Absolute paths to global script files */
  scripts: string[]
  /** Asset configs from angular.json */
  assets: AssetConfig[]
  /** File replacement pairs */
  fileReplacements: { replace: string; with: string }[]
  /** Whether to generate source maps */
  sourceMap: boolean
  /** Whether to optimize (minify, tree-shake) */
  optimization: boolean
  /** Output hashing mode */
  outputHashing: 'none' | 'all' | 'media' | 'bundles'
  /** Absolute path to output directory */
  outputPath: string
  /** Base href for the application */
  baseHref: string
  /** Deploy URL prefix for assets */
  deployUrl: string
  /** Polyfill entries (e.g. ["zone.js"]) */
  polyfills: string[]
  /** Global constant replacements */
  define: Record<string, string>
  /** Dependencies to treat as external */
  externalDependencies: string[]
  /** Preserve symlinks in module resolution */
  preserveSymlinks: boolean
  /** Use human-readable chunk names */
  namedChunks: boolean
  /** Cross-origin attribute for script/link tags */
  crossOrigin: 'none' | 'anonymous' | 'use-credentials'
  /** Sass/Less preprocessor options */
  stylePreprocessorOptions: { includePaths: string[] }
  /** Watch mode for build */
  watch: boolean
  /** File-watching poll interval in ms (0 = no polling) */
  poll: number
  /** Serve options */
  serve: { port?: number; open?: boolean; host?: string }
}

export type AssetConfig = string | { glob: string; input: string; output?: string }

export interface ResolveOptions {
  /** Project name or path */
  project?: string
  /** Configuration name */
  configuration?: string
  /** Command being run */
  command: 'serve' | 'build'
  /** Dev server port override */
  port?: number
  /** Open browser on start */
  open?: boolean
  /** Dev server host override */
  host?: string
  /** Watch mode override for build */
  watch?: boolean
}

// ═══════════════════════════════════════════════════════════════
//  Internal Types
// ═══════════════════════════════════════════════════════════════

interface Target {
  builder?: string
  executor?: string
  options?: Record<string, any>
  configurations?: Record<string, Record<string, any>>
  defaultConfiguration?: string
}

interface Project {
  name?: string
  root?: string
  sourceRoot?: string
  prefix?: string
  architect?: Record<string, Target>
  targets?: Record<string, Target>
}

interface WorkspaceJson {
  projects?: Record<string, Project>
  defaultProject?: string
}

type WorkspaceType = 'angular' | 'nx-project'

interface DetectedWorkspace {
  type: WorkspaceType
  root: string
  data: WorkspaceJson | Project
  projectJsonPath?: string
}

// ═══════════════════════════════════════════════════════════════
//  Detection
// ═══════════════════════════════════════════════════════════════

/**
 * Detect and read the workspace configuration.
 *
 * Supports:
 * - angular.json (standard Angular CLI)
 * - workspace.json (older Nx format)
 * - project.json (per-project Nx)
 * - Auto-detection via --project pointing to an Nx app directory
 */
export function detectWorkspace(cwd: string, projectHint?: string): DetectedWorkspace {
  // If projectHint points to a specific project.json or directory
  if (projectHint) {
    const hintPath = resolve(cwd, projectHint)

    // Direct path to project.json
    if (hintPath.endsWith('project.json') && existsSync(hintPath)) {
      return {
        type: 'nx-project',
        root: findWorkspaceRoot(dirname(hintPath)) ?? cwd,
        data: JSON.parse(readFileSync(hintPath, 'utf-8')),
        projectJsonPath: hintPath,
      }
    }

    // Directory containing project.json
    const dirProjectJson = join(hintPath, 'project.json')
    if (existsSync(dirProjectJson)) {
      return {
        type: 'nx-project',
        root: findWorkspaceRoot(hintPath) ?? cwd,
        data: JSON.parse(readFileSync(dirProjectJson, 'utf-8')),
        projectJsonPath: dirProjectJson,
      }
    }
  }

  // angular.json in cwd
  const angularJson = resolve(cwd, 'angular.json')
  if (existsSync(angularJson)) {
    return {
      type: 'angular',
      root: cwd,
      data: JSON.parse(readFileSync(angularJson, 'utf-8')),
    }
  }

  // workspace.json (some Nx workspaces)
  const workspaceJson = resolve(cwd, 'workspace.json')
  if (existsSync(workspaceJson)) {
    return {
      type: 'angular',
      root: cwd,
      data: JSON.parse(readFileSync(workspaceJson, 'utf-8')),
    }
  }

  // project.json in cwd (standalone Nx project or running from project dir)
  const projectJson = resolve(cwd, 'project.json')
  if (existsSync(projectJson)) {
    return {
      type: 'nx-project',
      root: findWorkspaceRoot(cwd) ?? cwd,
      data: JSON.parse(readFileSync(projectJson, 'utf-8')),
      projectJsonPath: projectJson,
    }
  }

  throw new Error(
    'No angular.json or project.json found.\n' +
    '  Run from an Angular/Nx workspace root, or use --project <path>.'
  )
}

/**
 * Walk up directories to find the workspace root (has nx.json or angular.json).
 */
function findWorkspaceRoot(from: string): string | null {
  let dir = resolve(from)
  while (true) {
    if (existsSync(join(dir, 'nx.json'))) return dir
    if (existsSync(join(dir, 'angular.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ═══════════════════════════════════════════════════════════════
//  Resolve
// ═══════════════════════════════════════════════════════════════

/**
 * Main entry: detect workspace type and resolve all build options.
 */
export function resolveWorkspace(cwd: string, opts: ResolveOptions): ResolvedBuildOptions {
  const ws = detectWorkspace(cwd, opts.project)

  if (ws.type === 'nx-project') {
    return resolveNxProject(ws, opts)
  }

  return resolveAngularWorkspace(ws, opts)
}

function resolveAngularWorkspace(ws: DetectedWorkspace, opts: ResolveOptions): ResolvedBuildOptions {
  const workspace = ws.data as WorkspaceJson
  const projects = workspace.projects ?? {}

  let projectName: string
  let project: Project

  if (opts.project && projects[opts.project]) {
    projectName = opts.project
    project = projects[opts.project]
  } else if (workspace.defaultProject && projects[workspace.defaultProject]) {
    projectName = workspace.defaultProject
    project = projects[workspace.defaultProject]
  } else {
    const entries = Object.entries(projects)
    if (entries.length === 0) throw new Error('No projects found in angular.json')
    ;[projectName, project] = entries[0]
  }

  return resolveProjectOptions(ws.root, projectName, project, opts)
}

function resolveNxProject(ws: DetectedWorkspace, opts: ResolveOptions): ResolvedBuildOptions {
  const project = ws.data as Project
  const projectName = project.name ?? basename(dirname(ws.projectJsonPath!))
  const projectDir = dirname(ws.projectJsonPath!)

  // Resolve root relative to workspace
  const projectRoot = project.root ?? relPath(ws.root, projectDir)

  const resolved: Project = {
    ...project,
    root: projectRoot,
    sourceRoot: project.sourceRoot ?? join(projectRoot, 'src'),
  }

  return resolveProjectOptions(ws.root, projectName, resolved, opts)
}

function relPath(base: string, target: string): string {
  const resolved = resolve(target)
  const baseResolved = resolve(base)
  if (resolved.startsWith(baseResolved)) {
    return resolved.slice(baseResolved.length + 1) || '.'
  }
  return resolved
}

function resolveProjectOptions(
  workspaceRoot: string,
  projectName: string,
  project: Project,
  opts: ResolveOptions,
): ResolvedBuildOptions {
  // Nx uses "targets", Angular CLI uses "architect"
  const targets = project.targets ?? project.architect ?? {}

  const buildTarget = targets['build']
  if (!buildTarget) {
    throw new Error(`No "build" target found for project "${projectName}"`)
  }

  const serveTarget = targets['serve']

  // Resolve configuration name
  let configName: string
  if (opts.configuration) {
    configName = opts.configuration
  } else if (opts.command === 'serve') {
    configName = serveTarget?.defaultConfiguration ?? 'development'
  } else {
    configName = buildTarget.defaultConfiguration ?? 'production'
  }

  // Merge base + config overrides
  const base = buildTarget.options ?? {}
  const overrides = buildTarget.configurations?.[configName]
  const merged = overrides ? { ...base, ...overrides } : { ...base }

  // Serve target options
  const serveBase = serveTarget?.options ?? {}
  const serveOverrides = serveTarget?.configurations?.[configName]
  const serveOpts = serveOverrides ? { ...serveBase, ...serveOverrides } : { ...serveBase }

  const projectRoot = project.root ?? ''
  const sourceRoot = project.sourceRoot ?? join(projectRoot, 'src')

  const abs = (p: string) => resolve(workspaceRoot, p)

  const tsconfig = abs(merged.tsConfig ?? join(projectRoot, 'tsconfig.app.json'))
  const browser = abs(merged.browser ?? merged.main ?? join(sourceRoot, 'main.ts'))

  const styles = (merged.styles ?? []).map((s: any) =>
    abs(typeof s === 'string' ? s : s.input)
  )

  const scripts = (merged.scripts ?? []).map((s: any) =>
    abs(typeof s === 'string' ? s : s.input)
  )

  const assets: AssetConfig[] = merged.assets ?? []

  const fileReplacements = (merged.fileReplacements ?? []).map((fr: any) => ({
    replace: abs(fr.replace),
    with: abs(fr.with),
  }))

  const sourceMap = merged.sourceMap ?? (configName !== 'production')
  const optimization = merged.optimization ?? (configName === 'production')
  const outputHashing = merged.outputHashing ?? (configName === 'production' ? 'all' : 'none')
  const outputPath = abs(merged.outputPath ?? join('dist', projectRoot || projectName))

  const baseHref = merged.baseHref ?? '/'
  const deployUrl = merged.deployUrl ?? ''
  const crossOrigin = merged.crossOrigin ?? 'none'
  const namedChunks = merged.namedChunks ?? false
  const preserveSymlinks = merged.preserveSymlinks ?? false
  const watch = opts.watch ?? merged.watch ?? false
  const poll = serveOpts.poll ?? merged.poll ?? 0

  const polyfills: string[] = Array.isArray(merged.polyfills)
    ? merged.polyfills
    : merged.polyfills ? [merged.polyfills] : []

  const define: Record<string, string> = merged.define ?? {}

  const externalDependencies: string[] = merged.externalDependencies ?? []

  const rawIncludePaths = merged.stylePreprocessorOptions?.includePaths ?? []
  const stylePreprocessorOptions = {
    includePaths: rawIncludePaths.map((p: string) => abs(p)),
  }

  return {
    workspaceRoot,
    projectName,
    configName,
    sourceRoot,
    tsconfig,
    browser,
    styles,
    scripts,
    assets,
    fileReplacements,
    sourceMap,
    optimization,
    outputHashing,
    outputPath,
    baseHref,
    deployUrl,
    polyfills,
    define,
    externalDependencies,
    preserveSymlinks,
    namedChunks,
    crossOrigin,
    stylePreprocessorOptions,
    watch,
    poll,
    serve: {
      port: opts.port ?? serveOpts.port ?? merged.port ?? 4200,
      open: opts.open ?? serveOpts.open ?? merged.open ?? false,
      host: opts.host ?? serveOpts.host,
    },
  }
}
