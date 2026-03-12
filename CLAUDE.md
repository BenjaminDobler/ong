# CLAUDE.md — Project Context for @richapps/ong

## What is this project?

**ong** is a drop-in replacement for the Angular CLI (`ng serve` / `ng build`) that uses Vite + the OXC Rust-based Angular compiler instead of Webpack/esbuild. It reads existing `angular.json` or Nx `project.json` workspace configs and requires no additional configuration.

## Architecture

```
src/
  cli.ts          — CLI entry point, arg parsing, main() orchestration
  workspace.ts    — Workspace detection (angular.json, project.json), option resolution
  config.ts       — Creates Vite InlineConfig from resolved Angular build options
  plugins.ts      — Custom Vite plugins: HTML injection (scripts/styles/polyfills), asset copy
  prebundle.ts    — Optional pre-bundling of local libs (--prebundle-libs) to resolve circular deps
  log.ts          — Terminal output: banner, build stats, help text, colors
  index.ts        — Programmatic API exports
```

### Key data flow

1. `cli.ts` parses args → calls `resolveWorkspace()` from `workspace.ts`
2. `workspace.ts` detects workspace type, reads config, merges base + configuration overrides → returns `ResolvedBuildOptions`
3. `config.ts` maps Angular options to Vite `InlineConfig` (aliases, css preprocessor, build output, etc.)
4. If `--prebundle-libs`, `prebundle.ts` bundles local workspace libs via Vite `build()` in library mode with OXC, rewrites aliases to point to bundled output
5. `cli.ts` calls `createServer()` or `build()` from Vite

## Build & Development

```bash
npm run build     # tsc — compiles src/ to dist/
npm run dev       # tsc --watch
npm publish --access public   # publish to npm as @richapps/ong
```

- TypeScript strict mode, ESM (`"type": "module"`)
- Output: `dist/` (JS + declarations)
- Binary: `bin/ong.js` (shebang wrapper that imports `dist/cli.js`)
- Global install: `npm install -g .` creates symlink, so local edits take effect immediately after `npm run build`

## Key Technical Details

### Vite + OXC integration
- `@oxc-angular/vite` provides the Angular compiler as Vite plugins — handles decorators, template compilation, etc., all in Rust
- Requires Vite `>=8.0.0-beta.10` (uses rolldown internally)
- OXC replaces both the TypeScript compiler and Angular compiler — no `ngc`/`ngtsc` involved

### tsconfig path alias resolution
- `resolveTsconfigPaths()` in `config.ts` walks the full `extends` chain
- `baseUrl` and `paths` are inherited from parent configs (child overrides parent)
- Produces Vite `resolve.alias` entries (exact matches + wildcard RegExp patterns)

### --prebundle-libs
- Bundles each local workspace library into a single ESM file using rolldown + OXC
- Output goes to `node_modules/.ong-prebundle/` (so Vite can resolve bare imports from node_modules)
- Externalizes all bare specifiers (npm packages + other local lib aliases), only bundles relative imports within each lib
- This resolves circular dependency TDZ errors that occur with Vite's unbundled ESM dev server
- Local libs are identified by checking which tsconfig path aliases point inside the workspace (not node_modules)

### Sass/CSS preprocessor
- `stylePreprocessorOptions.includePaths` from angular.json are resolved to absolute paths in `workspace.ts`
- Mapped to Vite's `css.preprocessorOptions.scss.loadPaths` (modern sass API, NOT `includePaths`)

### Workspace detection priority
1. `--project` pointing to a specific `project.json` or directory
2. `angular.json` in cwd
3. `workspace.json` in cwd
4. `project.json` in cwd
5. Walks up directories to find workspace root (looks for `nx.json` or `angular.json`)

## Testing

No test suite yet. To manually test:

```bash
npm run build
cd /path/to/angular-or-nx-workspace
ong serve
ong serve --prebundle-libs   # if circular deps
ong build -c production
```

## Common Gotchas

- After editing source, run `npm run build` before testing (unless using `npm run dev` for watch mode)
- If globally installed via `npm install -g .`, the symlink means rebuilt dist/ is used immediately
- Vite's dev server serves unbundled ESM — projects with circular dependencies in local libs need `--prebundle-libs`
- The `angular()` plugin from `@oxc-angular/vite` must process Angular files — esbuild/rolldown alone won't compile Angular decorators
- Sass modern API uses `loadPaths`, not `includePaths` — don't confuse them
