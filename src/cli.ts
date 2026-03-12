import { createServer, build } from 'vite'
import { resolveWorkspace, type ResolveOptions } from './workspace.js'
import { createViteConfig } from './config.js'
import { banner, printBuildStats, printHelp, error } from './log.js'

// ═══════════════════════════════════════════════════════════════
//  Argument Parsing
// ═══════════════════════════════════════════════════════════════

interface CliArgs {
  command: 'serve' | 'build' | 'help'
  project?: string
  configuration?: string
  port?: number
  open?: boolean
  host?: string
  watch?: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const command = args[0] as CliArgs['command']

  if (!command || !['serve', 'build'].includes(command)) {
    return { command: 'help' }
  }

  const result: CliArgs = { command }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    if (arg === '--project' || arg === '-p') {
      result.project = next; i++
    } else if (arg === '--configuration' || arg === '-c') {
      result.configuration = next; i++
    } else if (arg.startsWith('--configuration=')) {
      result.configuration = arg.split('=')[1]
    } else if (arg === '--port') {
      result.port = parseInt(next); i++
    } else if (arg === '--open' || arg === '-o') {
      result.open = true
    } else if (arg === '--host') {
      result.host = next; i++
    } else if (arg === '--watch' || arg === '-w') {
      result.watch = true
    } else if (arg === '--help' || arg === '-h') {
      return { command: 'help' }
    } else if (!arg.startsWith('-') && !result.project) {
      // Treat bare positional arg as project (e.g. "ong serve apps/editor")
      result.project = arg
    }
  }

  return result
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv)

  if (args.command === 'help') {
    printHelp()
    process.exit(0)
  }

  const cwd = process.cwd()

  const resolveOpts: ResolveOptions = {
    command: args.command,
    project: args.project,
    configuration: args.configuration,
    port: args.port,
    open: args.open,
    host: args.host,
    watch: args.watch,
  }

  const buildOpts = resolveWorkspace(cwd, resolveOpts)
  banner(args.command, buildOpts.projectName, buildOpts.configName)

  const viteConfig = createViteConfig(buildOpts)

  if (args.command === 'serve') {
    const server = await createServer(viteConfig)
    await server.listen()
    server.printUrls()
    console.log()
  }

  if (args.command === 'build') {
    const start = Date.now()
    await build(viteConfig)
    const duration = Date.now() - start
    printBuildStats(buildOpts.outputPath, duration)
  }
}

main().catch(err => {
  error(err.message)
})
