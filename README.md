<p align="center">
  <img src="ong-logo.png" alt="ong" width="200">
</p>

<h1 align="center">@richapps/ong</h1>

<p align="center">
  Angular CLI powered by <a href="https://vite.dev">Vite</a> + <a href="https://github.com/voidzero-dev/oxc-angular-compiler">OXC</a><br>
  <em>Blazing fast drop-in replacement for <code>ng serve</code> and <code>ng build</code></em>
</p>

---

## What is ong?

**ong** uses the Rust-based [OXC Angular compiler](https://github.com/voidzero-dev/oxc-angular-compiler) and [Vite](https://vite.dev) to compile and serve Angular applications — no Webpack, no esbuild, just raw speed.

It reads your existing `angular.json` (or Nx `project.json`) and works with a standard Angular project out of the box. No config files to write, no migration steps.

## Install

```bash
npm install -D @richapps/ong
```

If you already have `vite` installed, ong will use your version. Otherwise it will be auto-installed as a peer dependency.

For global usage:

```bash
npm install -g @richapps/ong
```

## Usage

```bash
# Start dev server
ong serve

# Production build
ong build

# With options
ong serve --port 3000 --open
ong build -c production
ong serve -p my-app              # specific project
ong build -p apps/my-app         # nx project path
```

Or via npm scripts in `package.json`:

```json
{
  "scripts": {
    "start": "ong serve",
    "build": "ong build"
  }
}
```

## CLI Options

| Option | Alias | Description |
|---|---|---|
| `--configuration <name>` | `-c` | Build configuration (default: per-target default) |
| `--project <name\|path>` | `-p` | Project name (angular.json) or path (nx project.json) |
| `--port <number>` | | Dev server port (default: 4200) |
| `--open` | `-o` | Open browser on start |
| `--host <host>` | | Dev server host |
| `--watch` | `-w` | Rebuild on file changes (build mode) |
| `--help` | `-h` | Show help |

## Workspace Support

ong auto-detects your workspace type:

- **angular.json** — Standard Angular CLI workspace
- **workspace.json** — Older Nx workspace format
- **project.json** — Per-project Nx monorepo setup

Configurations, file replacements, global styles/scripts, and assets are all read from your existing workspace config.

## Supported angular.json / project.json Properties

### Build target options

| Property | Status | Notes |
|---|---|---|
| `browser` / `main` | Supported | Entry point |
| `tsConfig` | Supported | |
| `outputPath` | Supported | |
| `assets` | Supported | String and object (`glob`/`input`/`output`) forms |
| `styles` | Supported | Global stylesheets, string and `{ input }` forms |
| `scripts` | Supported | Global scripts |
| `fileReplacements` | Supported | `replace`/`with` pairs |
| `sourceMap` | Supported | |
| `optimization` | Supported | Uses OXC minifier |
| `outputHashing` | Supported | `none`, `all`, `media`, `bundles` |
| `configurations` | Supported | Merges base + per-config overrides |
| `defaultConfiguration` | Supported | |
| `baseHref` | Supported | Injected into `<base href="...">` and used as Vite `base` |
| `deployUrl` | Supported | Maps to Vite `base` (takes precedence over `baseHref`) |
| `polyfills` | Supported | Injected as `<script>` tags (string or array) |
| `define` | Supported | Maps to Vite `define` for global constant replacements |
| `externalDependencies` | Supported | Maps to Rollup `external` |
| `preserveSymlinks` | Supported | Maps to Vite `resolve.preserveSymlinks` |
| `namedChunks` | Supported | Disables hash-based chunk naming |
| `crossOrigin` | Supported | Sets attribute on injected `<script>`/`<link>` tags |
| `stylePreprocessorOptions` | Supported | `includePaths` mapped to Vite `css.preprocessorOptions` |
| `watch` | Supported | Maps to Vite `build.watch` (also via `--watch` CLI flag) |
| `poll` | Supported | Maps to Vite `server.watch.usePolling` with interval |
| Tailwind CSS | Auto-detected | `tailwind.config.js` in the project directory is automatically wired into Vite's PostCSS pipeline |

### Serve target options

| Property | Status | Notes |
|---|---|---|
| `port` | Supported | |
| `open` | Supported | |
| `host` | Supported | |
| `poll` | Supported | File-watching poll interval |
| `buildTarget` | Supported | Build configuration is resolved from the serve target's `buildTarget` (e.g. `"app:build:standalone"`) |
| `defaultConfiguration` | Supported | Serve target's default configuration is used when no `-c` flag is passed |

### Not yet supported

These `@angular/build:application` properties are **not currently handled** — they are silently ignored:

| Property | Description |
|---|---|
| `budgets` | Bundle size budgets and warnings |
| `extractLicenses` | Extract third-party licenses to a separate file |
| `subresourceIntegrity` | SRI hashes on `<script>`/`<link>` tags |
| `allowedCommonJsDependencies` | Suppress CommonJS import warnings |
| `serviceWorker` / `ngswConfigPath` | PWA service worker generation |
| `webWorkerTsConfig` | Separate tsconfig for web workers |
| `i18nMissingTranslation` | i18n missing translation handling |
| `localize` | i18n locale builds |
| `inlineStyleLanguage` | Default preprocessor for inline component styles |
| `loader` | Custom file extension loaders |
| `progress` | Show build progress indicator |
| `ssr` / `server` / `prerender` | Server-side rendering / prerendering |
| `security` | Content Security Policy settings |

> SSR support is not planned — ong focuses on client-side Angular applications.

## Template Annotations (Visual Editing)

ong includes a built-in Vite plugin that annotates every HTML element in Angular templates with source-location metadata — without modifying source files on disk. This enables visual editing tools to map rendered DOM elements back to their exact template source.

### How It Works

When enabled, the plugin adds a short numeric `_ong` attribute to every template element at compile time. Rich metadata (file path, line, column, component info, bindings, text content type) is stored in a global `window.__ong_annotations` lookup table.

```html
<!-- Source file (untouched): -->
<h3>Hello World</h3>

<!-- Rendered DOM: -->
<h3 _ong="42">Hello World</h3>
```

```javascript
// In browser console:
window.__ong_annotations[42]
// → {
//   file: "src/app/header/header.html",
//   line: 3, col: 2,
//   tag: "h3",
//   component: "HeaderComponent",
//   selector: "app-header",
//   tsFile: "src/app/header/header.ts",
//   parent: 38,
//   inLoop: false,
//   conditional: false,
//   text: { hasText: true, type: "static", content: "Hello World" },
//   bindings: { inputs: {}, outputs: {}, twoWay: {}, structural: [] }
// }
```

### Enable

Set the `ADORABLE_ANNOTATE_TEMPLATES` environment variable:

```bash
ADORABLE_ANNOTATE_TEMPLATES=true ong serve
```

### Metadata Fields

Each annotation entry contains:

| Field | Description |
|---|---|
| `file` | Relative path to the template file (from workspace root) |
| `line` | 1-based line number in the template |
| `col` | 0-based column number |
| `tag` | HTML tag name |
| `component` | Angular component class name |
| `selector` | Component selector (e.g., `app-header`) |
| `tsFile` | Relative path to the component `.ts` file |
| `parent` | Annotation ID of the parent element (`null` for root) |
| `inLoop` | `true` if inside a `@for` block |
| `conditional` | `true` if inside a `@if` / `@switch` block |
| `text.hasText` | Whether the element has direct text content |
| `text.type` | `'static'` \| `'interpolated'` \| `'mixed'` \| `'none'` |
| `text.content` | The raw text or `{{ expression }}` content |
| `bindings.inputs` | Property bindings: `{ 'class.active': 'isActive' }` |
| `bindings.outputs` | Event bindings: `{ 'click': 'onClick()' }` |
| `bindings.twoWay` | Two-way bindings: `{ 'ngModel': 'name' }` |
| `bindings.structural` | Structural directives: `['*ngIf="visible"']` |

### Features

- Works with **external templates** (`templateUrl`) and **inline templates** (`template: \`...\``)
- Supports **any file naming convention** — `app.html`, `header.component.html`, etc.
- **Paths are workspace-relative** — portable, no absolute paths leaked
- **Survives HMR** — templates are re-annotated on file change
- **Zero source file modification** — annotations exist only in the Vite pipeline
- Uses `angular-html-parser` for accurate source spans

### Programmatic Usage

The plugin is also exported for use in custom Vite configs:

```typescript
import { templateAnnotatePlugin } from '@richapps/ong'

export default {
  plugins: [
    templateAnnotatePlugin(),
    // ... other plugins
  ]
}
```

## Programmatic API

```typescript
import { resolveWorkspace, createViteConfig } from '@richapps/ong'

const opts = resolveWorkspace(process.cwd(), {
  command: 'build',
  configuration: 'production',
})

const viteConfig = createViteConfig(opts)
```

## Requirements

- Node.js 18+
- Angular 19+ (required by the OXC Angular compiler)
- Vite 8+ (beta)

## License

MIT
