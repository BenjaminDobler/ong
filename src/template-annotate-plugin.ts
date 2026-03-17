import type { Plugin } from 'vite'
import { parse } from 'angular-html-parser'
import { readFileSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'

export interface AnnotationEntry {
  /** Relative path to the template file (from workspace root) */
  file: string
  /** 1-based line number in the template */
  line: number
  /** 0-based column number */
  col: number
  /** HTML tag name */
  tag: string
  /** Angular component class name that owns this template */
  component: string
  /** Component selector (e.g. 'app-header') */
  selector: string
  /** Relative path to the component .ts file */
  tsFile: string
  /** Annotation ID of the parent element (null for root elements) */
  parent: number | null
  /** Whether this element is inside a @for loop */
  inLoop: boolean
  /** Whether this element is inside a @if / @switch conditional */
  conditional: boolean
  /** Text content info */
  text: {
    /** Whether the element has any direct text content */
    hasText: boolean
    /** Whether the text is static (plain text) or dynamic (contains {{ }} interpolation) */
    type: 'static' | 'interpolated' | 'mixed' | 'none'
    /** The raw text/expression content */
    content: string
  }
  /** Angular bindings on this element */
  bindings: {
    /** Property/attribute bindings: { 'class.active': 'isActive', 'src': 'imageUrl' } */
    inputs: Record<string, string>
    /** Event bindings: { 'click': 'onClick()', 'keydown.enter': 'onSubmit()' } */
    outputs: Record<string, string>
    /** Two-way bindings: { 'ngModel': 'name' } */
    twoWay: Record<string, string>
    /** Structural context (e.g. '@for (item of items; track item.id)') */
    structural: string[]
  }
}

/**
 * Vite plugin that annotates Angular component templates with source-location
 * metadata. Each HTML element gets a short numeric `_ong` attribute.
 * The full metadata is stored in `window.__ong_annotations` —
 * a global lookup table injected at module load time.
 *
 * Works with:
 * - External template files (any name — `app.html`, `header.component.html`, etc.)
 * - Inline templates (`template: \`...\`` in `.ts` files)
 * - Angular 19+ naming conventions (no `.component` suffix required)
 *
 * Paths are relative to the workspace root for portability.
 */
export function templateAnnotatePlugin(): Plugin {
  let workspaceRoot = ''
  let nextId = 1

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

          // Extract component metadata from the .ts source
          const componentInfo = extractComponentInfo(code)
          const tsRelPath = relative(workspaceRoot, id)

          // Handle external templates (templateUrl)
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

          // Append side-effect that registers annotations at module load time
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
  }

  /**
   * Parse HTML template, add numeric `_ong` attributes, and collect rich annotation entries.
   */
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
        // Track structural control flow blocks (@for, @if, @switch)
        // These aren't elements but affect their children's context
        if (node.type === 'block') {
          const blockName = node.name || ''
          const isLoop = blockName === 'for'
          const isCond = blockName === 'if' || blockName === 'switch' || blockName === 'case' || blockName === 'else'
          if (node.children) {
            walk(node.children, parentId, inLoop || isLoop, conditional || isCond)
          }
          // Also walk block parameters (e.g., @else blocks)
          if (node.parameters) {
            for (const param of node.parameters) {
              if (param.children) walk(param.children, parentId, inLoop || isLoop, conditional || isCond)
            }
          }
          continue
        }

        if (!node.name || !node.startSourceSpan) continue

        const line = node.sourceSpan.start.line + 1 + lineOffset
        const col = node.sourceSpan.start.col
        const elemId = nextId++

        // Extract text content info
        const textInfo = extractTextInfo(node)

        // Extract Angular bindings from attributes
        const bindings = extractBindings(node)

        // Collect structural context from ancestor blocks
        const structuralContext = collectStructuralContext(node)
        if (structuralContext.length > 0) {
          bindings.structural = structuralContext
        }

        const annotation: AnnotationEntry = {
          file: templateRelPath,
          line,
          col,
          tag: node.name,
          component: componentInfo.className,
          selector: componentInfo.selector,
          tsFile: tsRelPath,
          parent: parentId,
          inLoop,
          conditional,
          text: textInfo,
          bindings,
        }

        outAnnotations.push(annotation)
        outIds.push(elemId)

        const tagEnd = node.startSourceSpan.end.offset
        const isSelfClosing = html.charAt(tagEnd - 2) === '/'
        const insertPos = isSelfClosing ? tagEnd - 2 : tagEnd - 1

        insertions.push({
          offset: insertPos,
          attr: ` _ong="${elemId}"`,
        })

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

// ── Helpers ──────────────────────────────────────────────────

interface ComponentInfo {
  className: string
  selector: string
}

/**
 * Extract component class name and selector from the .ts source code.
 */
function extractComponentInfo(code: string): ComponentInfo {
  let className = ''
  let selector = ''

  // Find selector in @Component({ selector: '...' })
  const selectorMatch = code.match(/selector\s*:\s*['"`]([^'"`]+)['"`]/)
  if (selectorMatch) selector = selectorMatch[1]

  // Find class name: "export class FooComponent" or "class FooComponent"
  const classMatch = code.match(/(?:export\s+)?class\s+(\w+)/)
  if (classMatch) className = classMatch[1]

  return { className, selector }
}

/**
 * Extract text content info from an element's children.
 * Determines whether text is static, interpolated ({{ }}), or mixed.
 */
function extractTextInfo(node: any): AnnotationEntry['text'] {
  if (!node.children || node.children.length === 0) {
    return { hasText: false, type: 'none', content: '' }
  }

  // Collect direct text children (nodes without a name are text nodes)
  const textParts: string[] = []
  let hasInterpolation = false
  let hasStaticText = false

  for (const child of node.children) {
    // Text nodes have no `name` property, just `value`
    if (!child.name && child.value) {
      const trimmed = child.value.trim()
      if (!trimmed) continue
      textParts.push(trimmed)

      if (/\{\{.*?\}\}/.test(trimmed)) {
        hasInterpolation = true
        // Check if there's also static text around the interpolation
        const withoutInterpolation = trimmed.replace(/\{\{.*?\}\}/g, '').trim()
        if (withoutInterpolation) hasStaticText = true
      } else {
        hasStaticText = true
      }
    }
  }

  if (textParts.length === 0) {
    return { hasText: false, type: 'none', content: '' }
  }

  const content = textParts.join(' ')
  let type: AnnotationEntry['text']['type'] = 'static'

  if (hasInterpolation && hasStaticText) {
    type = 'mixed'
  } else if (hasInterpolation) {
    type = 'interpolated'
  }

  return { hasText: true, type, content }
}

/**
 * Extract Angular bindings from an element's attributes.
 */
function extractBindings(node: any): AnnotationEntry['bindings'] {
  const inputs: Record<string, string> = {}
  const outputs: Record<string, string> = {}
  const twoWay: Record<string, string> = {}
  const structural: string[] = []

  if (!node.attrs) return { inputs, outputs, twoWay, structural }

  for (const attr of node.attrs) {
    const name: string = attr.name
    const value: string = attr.value || ''

    // Two-way binding: [(ngModel)]="expr"
    if (name.startsWith('[(') && name.endsWith(')]')) {
      twoWay[name.slice(2, -2)] = value
    }
    // Property/attribute binding: [prop]="expr" or [attr.x]="expr" or [class.x]="expr"
    else if (name.startsWith('[') && name.endsWith(']')) {
      inputs[name.slice(1, -1)] = value
    }
    // Event binding: (click)="handler()"
    else if (name.startsWith('(') && name.endsWith(')')) {
      outputs[name.slice(1, -1)] = value
    }
    // bind- prefix: bind-prop="expr"
    else if (name.startsWith('bind-')) {
      inputs[name.slice(5)] = value
    }
    // on- prefix: on-click="handler()"
    else if (name.startsWith('on-')) {
      outputs[name.slice(3)] = value
    }
    // Structural directives: *ngIf, *ngFor
    else if (name.startsWith('*')) {
      structural.push(`${name}="${value}"`)
    }
  }

  return { inputs, outputs, twoWay, structural }
}

/**
 * Walk up from a node to find enclosing @for / @if blocks.
 * Returns structural context strings like '@for (item of items; track item.id)'.
 */
function collectStructuralContext(node: any): string[] {
  // angular-html-parser doesn't provide parent references directly,
  // so structural context is tracked via the walk() function's inLoop/conditional flags.
  // This function is reserved for future use with richer AST traversal.
  return []
}

function escapeTemplateLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}
