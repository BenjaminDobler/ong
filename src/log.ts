import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
}

export function banner(command: string, projectName: string, configName: string) {
  console.log()
  console.log(`  ${c.green}${c.bold}ong${c.reset} ${c.dim}— Angular + OXC + Vite${c.reset}`)
  console.log()
  console.log(`  ${c.dim}Command:${c.reset}        ${command}`)
  console.log(`  ${c.dim}Project:${c.reset}        ${projectName}`)
  console.log(`  ${c.dim}Configuration:${c.reset}  ${configName}`)
  console.log()
}

export function error(msg: string): never {
  console.error(`\n  ${c.red}${c.bold}Error:${c.reset} ${msg}\n`)
  process.exit(1)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

export function printBuildStats(outDir: string, durationMs: number) {
  console.log()
  console.log(`  ${c.green}${c.bold}Build complete${c.reset} in ${c.bold}${durationMs}ms${c.reset}`)
  console.log(`  ${c.dim}Output:${c.reset} ${relative(process.cwd(), outDir)}`)
  console.log()

  try {
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
    const entries: { path: string; size: number }[] = []

    for (const f of files) {
      if (f.isFile()) {
        const fullPath = join(f.parentPath ?? (f as any).path, f.name)
        const stat = statSync(fullPath)
        entries.push({ path: relative(outDir, fullPath), size: stat.size })
      }
    }

    entries.sort((a, b) => b.size - a.size)
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0)

    for (const entry of entries.slice(0, 15)) {
      const sizeStr = formatBytes(entry.size).padStart(10)
      const isJs = entry.path.endsWith('.js')
      const isCss = entry.path.endsWith('.css')
      const color = isJs ? c.yellow : isCss ? c.cyan : c.dim
      console.log(`  ${color}${sizeStr}${c.reset}  ${entry.path}`)
    }
    if (entries.length > 15) {
      console.log(`  ${c.dim}... and ${entries.length - 15} more files${c.reset}`)
    }

    console.log()
    console.log(`  ${c.bold}Total: ${formatBytes(totalSize)}${c.reset}`)
  } catch {
    // ignore
  }
  console.log()
}

export function printHelp() {
  console.log(`
  ${c.green}${c.bold}ong${c.reset} ${c.dim}— Angular CLI powered by Vite + OXC${c.reset}

  ${c.bold}Commands:${c.reset}
    serve                       Start dev server
    build                       Build for production

  ${c.bold}Options:${c.reset}
    -c, --configuration <name>  Build configuration (default: per-target default)
    -p, --project <name>        Project name (angular.json) or path (nx project.json)
        --port <number>         Dev server port (default: 4200)
    -o, --open                  Open browser on start
        --host <host>           Dev server host
    -w, --watch                 Rebuild on file changes (build mode)
        --prebundle-libs            Pre-bundle local libs to resolve circular deps

  ${c.bold}Workspace support:${c.reset}
    angular.json                Standard Angular CLI workspace
    project.json                Nx monorepo (auto-detected)

  ${c.bold}Examples:${c.reset}
    ong serve
    ong build -c production
    ong serve --port 3000 --open
    ong build -p my-app -c production
    ong serve -p apps/my-app                ${c.dim}# nx project path${c.reset}
`)
}

export { c }
