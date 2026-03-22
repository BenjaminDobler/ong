import type { Plugin } from 'vite'
import { parse } from 'angular-html-parser'
import { relative, dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export interface AnnotationEntry {
  file: string
  line: number
  col: number
  tag: string
  component: string
  selector: string
  tsFile: string
  parent: number | null
  inLoop: boolean
  conditional: boolean
  text: {
    hasText: boolean
    type: 'static' | 'interpolated' | 'mixed' | 'none'
    content: string
  }
  bindings: {
    inputs: Record<string, string>
    outputs: Record<string, string>
    twoWay: Record<string, string>
    structural: string[]
  }
}

interface ComponentInfo { className: string; selector: string }

/**
 * Global annotation state — shared between the templateTransform callback
 * and the post-transform plugin hook that appends registration code.
 */
// Per-file ID bases: each file gets a stable base so IDs are deterministic across HMR
const fileIdBases = new Map<string, number>()
let nextFileBase = 0
const FILE_ID_SLOTS = 10000 // max elements per template file

function getFileIdBase(filePath: string): number {
  let base = fileIdBases.get(filePath)
  if (base === undefined) {
    base = nextFileBase
    nextFileBase += FILE_ID_SLOTS
    fileIdBases.set(filePath, base)
  }
  return base
}

// Keyed by template absolute path → array of { id, entry } collected during templateTransform
const pendingAnnotations = new Map<string, { id: number; entry: AnnotationEntry }[]>()
// Template absolute path → component .ts file that owns it
const templateToTsPath = new Map<string, string>()

/**
 * Standalone function that annotates a template's HTML content.
 * Used as the `templateTransform` callback for @oxc-angular/vite.
 *
 * OXC calls this both on initial load and on HMR re-reads, so
 * annotations stay in sync without any custom HMR handling.
 *
 * Uses per-file deterministic IDs so that HMR re-processing produces
 * the same IDs, keeping window.__ong_annotations in sync with the DOM.
 */
export function annotateTemplateContent(
  html: string,
  filePath: string,
  workspaceRoot: string,
): string {
  const relPath = relative(workspaceRoot, filePath)

  // Find the component .ts file that owns this template
  const tsPath = templateToTsPath.get(filePath)
  const tsRelPath = tsPath ? relative(workspaceRoot, tsPath) : relPath.replace(/\.html$/, '.ts')

  // Read component info from the .ts file if available
  let componentInfo: ComponentInfo = { className: '', selector: '' }
  if (tsPath) {
    try {
      const tsCode = readFileSync(tsPath, 'utf-8')
      componentInfo = extractComponentInfo(tsCode)
    } catch { /* ignore */ }
  }

  const annotations: { id: number; entry: AnnotationEntry }[] = []

  let parsed
  try {
    parsed = parse(html, { canSelfClose: true, allowHtmComponentClosingTags: true })
  } catch {
    return html
  }

  const insertions: { offset: number; attr: string }[] = []
  // Use per-file deterministic ID base — resets to same base on each call
  const idBase = getFileIdBase(filePath)
  let localIndex = 0

  function walk(nodes: any[], parentId: number | null, inLoop: boolean, conditional: boolean) {
    for (const node of nodes) {
      if (node.type === 'block') {
        const blockName = node.name || ''
        const isLoop = blockName === 'for'
        const isCond = blockName === 'if' || blockName === 'switch' || blockName === 'case' || blockName === 'else'
        if (node.children) walk(node.children, parentId, inLoop || isLoop, conditional || isCond)
        continue
      }
      if (!node.name || !node.startSourceSpan) continue

      const line = node.sourceSpan.start.line + 1
      const col = node.sourceSpan.start.col
      const elemId = idBase + (++localIndex)
      const textInfo = extractTextInfo(node)
      const bindings = extractBindings(node)

      const entry: AnnotationEntry = {
        file: relPath, line, col,
        tag: node.name,
        component: componentInfo.className,
        selector: componentInfo.selector,
        tsFile: tsRelPath,
        parent: parentId, inLoop, conditional,
        text: textInfo, bindings,
      }
      annotations.push({ id: elemId, entry })

      const tagEnd = node.startSourceSpan.end.offset
      const isSelfClosing = html.charAt(tagEnd - 2) === '/'
      const insertPos = isSelfClosing ? tagEnd - 2 : tagEnd - 1
      insertions.push({ offset: insertPos, attr: ` _ong="${elemId}"` })

      if (node.children) walk(node.children, elemId, inLoop, conditional)
    }
  }

  walk(parsed.rootNodes, null, false, false)
  if (insertions.length === 0) return html

  // Store annotations for the post-transform hook to pick up
  pendingAnnotations.set(filePath, annotations)

  let result = html
  for (const ins of insertions.reverse()) {
    result = result.slice(0, ins.offset) + ins.attr + result.slice(ins.offset)
  }
  return result
}

/**
 * Vite plugin that works alongside OXC's templateTransform to:
 * 1. Inject `window.__ong_annotations = {}` + HMR listener into index.html
 * 2. Scan .ts files to map templateUrl → .ts file path (for component info lookup)
 * 3. Prevent Vite full-reloads on template .html changes (OXC handles HMR)
 */
export function templateAnnotatePlugin(workspaceRootOverride?: string): Plugin {
  let workspaceRoot = ''

  return {
    name: 'ong:template-annotate',
    enforce: 'pre',

    configResolved(config) {
      const fsAllow = (config.server?.fs?.allow ?? []) as string[]
      workspaceRoot = workspaceRootOverride || fsAllow[0] || resolve(config.root, '..')
    },

    transformIndexHtml: {
      order: 'post' as const,
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'text/javascript' },
            children: `window.__ong_annotations = window.__ong_annotations || {};`,
            injectTo: 'head' as const,
          },
        ]
      },
    },

    // Pre-transform: scan .ts files to populate templateToTsPath map
    // so annotateTemplateContent can look up component info
    transform: {
      order: 'pre' as const,
      filter: { id: /\.tsx?/ },
      handler(code: string, id: string) {
        if (id.includes('node_modules')) return null
        if (!code.includes('@Component')) return null

        const cleanId = id.replace(/\?.*$/, '')

        // Register templateUrl → ts path mappings
        const templateUrlRegex = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g
        let match
        while ((match = templateUrlRegex.exec(code)) !== null) {
          const templatePath = resolve(dirname(cleanId), match[1])
          templateToTsPath.set(templatePath, cleanId)
        }

        return null // Don't modify the code — OXC handles template resolution
      },
    },

  }
}

/**
 * Post-transform plugin that appends annotation registrations to compiled
 * component output. Runs AFTER OXC compilation.
 */
export function templateAnnotatePostPlugin(): Plugin {
  return {
    name: 'ong:template-annotate-post',
    enforce: 'post',

    transform: {
      filter: { id: /\.tsx?/ },
      handler(code: string, id: string) {
        if (id.includes('node_modules')) return null

        // Strip query params for consistent matching
        const cleanId = id.replace(/\?.*$/, '')

        // Find any pending annotations for templates owned by this .ts file
        const ownedTemplates: string[] = []
        for (const [templatePath, tsPath] of templateToTsPath.entries()) {
          if (tsPath === cleanId) ownedTemplates.push(templatePath)
        }

        if (ownedTemplates.length === 0) return null

        const allAnnotations: { id: number; entry: AnnotationEntry }[] = []
        for (const tp of ownedTemplates) {
          const anns = pendingAnnotations.get(tp)
          if (anns) {
            allAnnotations.push(...anns)
            // Don't delete — OXC caches templates, so on subsequent transform
            // passes (e.g. after dep optimization reload) templateTransform won't
            // be called again. Keep annotations for re-use.
          }
        }

        if (allAnnotations.length === 0) return null

        const registrations = allAnnotations
          .map(a => `  w[${a.id}] = ${JSON.stringify(a.entry)};`)
          .join('\n')

        const result = code + `\n;(function() {\n  var w = (window.__ong_annotations = window.__ong_annotations || {});\n${registrations}\n})();\n`

        return { code: result, map: null }
      },
    },
  }
}

function extractComponentInfo(code: string): ComponentInfo {
  const selectorMatch = code.match(/selector\s*:\s*['"`]([^'"`]+)['"`]/)
  const classMatch = code.match(/(?:export\s+)?class\s+(\w+)/)
  return { className: classMatch?.[1] || '', selector: selectorMatch?.[1] || '' }
}

function extractTextInfo(node: any): AnnotationEntry['text'] {
  if (!node.children?.length) return { hasText: false, type: 'none', content: '' }
  const textParts: string[] = []
  let hasInterpolation = false, hasStaticText = false
  for (const child of node.children) {
    if (!child.name && child.value) {
      const trimmed = child.value.trim()
      if (!trimmed) continue
      textParts.push(trimmed)
      if (/\{\{.*?\}\}/.test(trimmed)) {
        hasInterpolation = true
        if (trimmed.replace(/\{\{.*?\}\}/g, '').trim()) hasStaticText = true
      } else { hasStaticText = true }
    }
  }
  if (!textParts.length) return { hasText: false, type: 'none', content: '' }
  let type: 'static' | 'interpolated' | 'mixed' = 'static'
  if (hasInterpolation && hasStaticText) type = 'mixed'
  else if (hasInterpolation) type = 'interpolated'
  return { hasText: true, type, content: textParts.join(' ') }
}

function extractBindings(node: any): AnnotationEntry['bindings'] {
  const inputs: Record<string, string> = {}, outputs: Record<string, string> = {}
  const twoWay: Record<string, string> = {}, structural: string[] = []
  for (const attr of (node.attrs || [])) {
    const n: string = attr.name, v: string = attr.value || ''
    if (n.startsWith('[(') && n.endsWith(')]')) twoWay[n.slice(2, -2)] = v
    else if (n.startsWith('[') && n.endsWith(']')) inputs[n.slice(1, -1)] = v
    else if (n.startsWith('(') && n.endsWith(')')) outputs[n.slice(1, -1)] = v
    else if (n.startsWith('*')) structural.push(`${n}="${v}"`)
  }
  return { inputs, outputs, twoWay, structural }
}
