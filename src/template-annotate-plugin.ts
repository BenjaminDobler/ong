import type { Plugin } from 'vite'
import { parse } from 'angular-html-parser'
import { readFileSync, utimesSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'

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

/**
 * Vite plugin that annotates Angular component templates with source-location
 * metadata. Each HTML element gets a short numeric `_ong` attribute.
 * The full metadata is stored in `window.__ong_annotations`.
 *
 * This plugin works by running AFTER OXC's angular plugin in a post-transform phase.
 * It doesn't modify templates directly — instead, it wraps OXC's angular plugin
 * to intercept and annotate templates during resource resolution.
 */
export function templateAnnotatePlugin(): Plugin {
  let workspaceRoot = ''
  let nextId = 1
  let viteServer: any = null
  // Track template file → component .ts file path for HMR
  const templateToTsPath = new Map<string, string>()
  // Track component .ts file → class name for triggering Angular HMR events
  const tsPathToClassName = new Map<string, string>()

  return {
    name: 'ong:template-annotate',
    enforce: 'pre',

    configResolved(config) {
      const fsAllow = (config.server?.fs?.allow ?? []) as string[]
      workspaceRoot = fsAllow[0] || resolve(config.root, '..')
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

    transform: {
      order: 'pre' as const,
      filter: {
        id: /\.tsx?$/,
      },
      handler(code: string, id: string) {
        if (id.includes('node_modules')) return null
        if (!code.includes('@Component')) return null

        try {
          let result = code
          let modified = false
          const localAnnotations: AnnotationEntry[] = []
          const localIds: number[] = []

          const componentInfo = extractComponentInfo(code)
          const tsRelPath = relative(workspaceRoot, id)
          if (componentInfo.className) {
            tsPathToClassName.set(id, componentInfo.className)
          }

          // Handle external templates (templateUrl) — annotate and inline
          const templateUrlRegex = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g
          let match
          while ((match = templateUrlRegex.exec(code)) !== null) {
            const templateUrl = match[1]
            const templatePath = resolve(dirname(id), templateUrl)

            let templateContent: string
            try {
              templateContent = readFileSync(templatePath, 'utf-8')
            } catch {
              continue
            }

            templateToTsPath.set(templatePath, id)

            const relPath = relative(workspaceRoot, templatePath)
            const annotated = annotateTemplate(templateContent, relPath, tsRelPath, 0, componentInfo, localAnnotations, localIds)
            if (annotated !== templateContent) {
              const fullMatch = match[0]
              const replacement = `template: \`${escapeTemplateLiteral(annotated)}\``
              result = result.replace(fullMatch, replacement)
              modified = true
            }
          }

          // Handle inline templates (template: `...`)
          const inlineBacktickRegex = /template\s*:\s*`([\s\S]*?)`/g
          while ((match = inlineBacktickRegex.exec(result)) !== null) {
            if (modified && match[0].includes('_ong=')) continue
            const templateContent = match[1]
            const unescaped = templateContent.replace(/\\`/g, '`').replace(/\\\$/g, '$')
            const templateStartOffset = match.index + match[0].indexOf(match[1])
            const linesBeforeTemplate = result.slice(0, templateStartOffset).split('\n').length - 1
            const annotated = annotateTemplate(unescaped, tsRelPath, tsRelPath, linesBeforeTemplate, componentInfo, localAnnotations, localIds)
            if (annotated !== unescaped) {
              const escaped = escapeTemplateLiteral(annotated)
              result = result.slice(0, match.index) +
                `template: \`${escaped}\`` +
                result.slice(match.index + match[0].length)
              modified = true
            }
          }

          if (!modified) return null

          const registrations = localAnnotations
            .map((a, i) => `  w[${localIds[i]}] = ${JSON.stringify(a)};`)
            .join('\n')

          result += `\n;(function() {\n  var w = (window.__ong_annotations = window.__ong_annotations || {});\n${registrations}\n})();\n`

          return { code: result, map: null }
        } catch {
          return null
        }
      },
    },

    // Store server reference so we can add files to its watcher during transform
    configureServer(server) {
      viteServer = server
    },

    // When a template file changes, find the parent .ts module and trigger its re-transform.
    handleHotUpdate({ file }: any) {
      const tsPath = templateToTsPath.get(file)
      if (tsPath) {
        // Touch the .ts file (update its mtime without changing content).
        // This triggers OXC's own transform + HMR pipeline for the component,
        // which re-runs our pre-transform (re-reads template from disk with
        // fresh content) and then OXC compiles + sends angular:component-update.
        console.log('[ong:annotate] HMR: template changed, touching .ts file:', tsPath)
        const now = new Date()
        try { utimesSync(tsPath, now, now) } catch { /* ignore */ }
        return []
      }
      if (file?.endsWith('.html') && !file.includes('index.html')) {
        return []
      }
    },
  }

  function annotateTemplate(
    html: string,
    templateRelPath: string,
    tsRelPath: string,
    lineOffset: number,
    componentInfo: ComponentInfo,
    outAnnotations: AnnotationEntry[],
    outIds: number[],
  ): string {
    let parsed
    try {
      parsed = parse(html, {
        canSelfClose: true,
        allowHtmComponentClosingTags: true,
      })
    } catch {
      return html
    }

    const insertions: { offset: number; attr: string }[] = []

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

        const line = node.sourceSpan.start.line + 1 + lineOffset
        const col = node.sourceSpan.start.col
        const elemId = nextId++
        const textInfo = extractTextInfo(node)
        const bindings = extractBindings(node)

        outAnnotations.push({
          file: templateRelPath, line, col,
          tag: node.name,
          component: componentInfo.className,
          selector: componentInfo.selector,
          tsFile: tsRelPath,
          parent: parentId, inLoop, conditional,
          text: textInfo, bindings,
        })
        outIds.push(elemId)

        const tagEnd = node.startSourceSpan.end.offset
        const isSelfClosing = html.charAt(tagEnd - 2) === '/'
        const insertPos = isSelfClosing ? tagEnd - 2 : tagEnd - 1
        insertions.push({ offset: insertPos, attr: ` _ong="${elemId}"` })

        if (node.children) walk(node.children, elemId, inLoop, conditional)
      }
    }

    walk(parsed.rootNodes, null, false, false)
    if (insertions.length === 0) return html

    let result = html
    for (const ins of insertions.reverse()) {
      result = result.slice(0, ins.offset) + ins.attr + result.slice(ins.offset)
    }
    return result
  }
}

interface ComponentInfo { className: string; selector: string }

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

function escapeTemplateLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}
