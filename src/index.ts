/**
 * Programmatic API for @richapps/ong
 *
 * Usage:
 *   import { resolveWorkspace, createViteConfig } from '@richapps/ong'
 *
 *   const opts = resolveWorkspace(process.cwd(), { command: 'build', configuration: 'production' })
 *   const viteConfig = createViteConfig(opts)
 */
export { resolveWorkspace, detectWorkspace } from './workspace.js'
export type { ResolvedBuildOptions, ResolveOptions, AssetConfig } from './workspace.js'
export { createViteConfig } from './config.js'
export { htmlInjectPlugin, assetCopyPlugin } from './plugins.js'
export { templateAnnotatePlugin } from './template-annotate-plugin.js'
export { prebundleLibs } from './prebundle.js'
