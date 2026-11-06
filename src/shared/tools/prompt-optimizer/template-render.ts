/**
 * The Mustache subset the ported builtin templates use.
 *
 * Porting a hundred templates means porting the syntax they are written in: interpolation, sections,
 * inverted sections, dotted names, the current item, delimiter switches and one lambda helper. A
 * full library is not added for this; the subset is small, the templates are trusted data, and the
 * renderer never sees reader input as a template.
 */

interface Frame {
  value: unknown
  parent: Frame | null
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
}

function lookup(frame: Frame | null, path: string): unknown {
  if (path === '.') return frame?.value
  const parts = path.split('.')
  // Mustache resolves the first segment against the whole context stack, so a section item can still
  // reach root-level helpers (e.g. `{{#items}}{{#helpers.toJson}}{{{label}}}{{/helpers.toJson}}{{/items}}`).
  let current: Frame | null = frame
  let base: unknown
  let found = false
  while (current) {
    const container = current.value
    if (container !== null && typeof container === 'object' && parts[0] in (container as Record<string, unknown>)) {
      base = (container as Record<string, unknown>)[parts[0]]
      found = true
      break
    }
    current = current.parent
  }
  if (!found) return undefined
  let value = base
  for (let index = 1; index < parts.length; index += 1) {
    if (value === null || value === undefined) return undefined
    if (typeof value !== 'object') return undefined
    if (parts[index] === '') continue
    value = (value as Record<string, unknown>)[parts[index]]
  }
  return value
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

interface ParseResult {
  text: string
  index: number
}

function renderNodes(
  template: string,
  start: number,
  open: string,
  close: string,
  frame: Frame | null,
): ParseResult {
  let out = ''
  let index = start
  while (index < template.length) {
    const opening = template.indexOf(open, index)
    if (opening === -1) {
      out += template.slice(index)
      return { text: out, index: template.length }
    }
    out += template.slice(index, opening)
    if (open === '{{' && template.startsWith('{{{', opening)) {
      const tripleEnd = template.indexOf('}}}', opening + 3)
      if (tripleEnd === -1) {
        out += template.slice(opening)
        return { text: out, index: template.length }
      }
      const tripleName = template.slice(opening + 3, tripleEnd).trim()
      const tripleValue = tripleName === '.' ? frame?.value : lookup(frame, tripleName)
      if (tripleValue !== null && tripleValue !== undefined) out += String(tripleValue)
      index = tripleEnd + 3
      continue
    }
    const closingTag = template.indexOf(close, opening)
    if (closingTag === -1) {
      out += template.slice(opening)
      return { text: out, index: template.length }
    }
    const raw = template.slice(opening + open.length, closingTag)
    const after = closingTag + close.length

    if (raw.startsWith('=') && raw.endsWith('=')) {
      const spec = raw.slice(1, -1).trim().split(/\s+/)
      if (spec.length === 2) {
        const result = renderNodes(template, after, spec[0], spec[1], frame)
        out += result.text
        return { text: out, index: result.index }
      }
      index = after
      continue
    }

    const tag = raw.trim()
    if (tag.startsWith('!')) {
      index = after
      continue
    }

    if (tag.startsWith('#') || tag.startsWith('^')) {
      const inverted = tag.startsWith('^')
      const name = tag.slice(1).trim()
      const closer = `${open}/${name}${close}`
      const end = findSectionEnd(template, after, open, close, closer)
      const body = template.slice(after, end.bodyEnd)
      const value = name === '.' ? frame?.value : lookup(frame, name)
      if (typeof value === 'function') {
        const rendered = (value as (text: string, render: (text: string) => string) => unknown)(
          body,
          (text: string) => renderNodes(text, 0, open, close, frame).text,
        )
        out += String(rendered ?? '')
      } else if (inverted) {
        if (!truthy(value)) out += renderNodes(body, 0, open, close, frame).text
      } else if (Array.isArray(value)) {
        for (const item of value) out += renderNodes(body, 0, open, close, { value: item, parent: frame }).text
      } else if (truthy(value)) {
        const child: Frame = { value, parent: frame }
        out += renderNodes(body, 0, open, close, child).text
      }
      index = end.next
      continue
    }

    if (tag.startsWith('/')) {
      return { text: out, index: after }
    }

    if (tag === '') {
      index = after
      continue
    }

    const triple = tag.startsWith('{') && tag.endsWith('}')
    const name = triple ? tag.slice(1, -1).trim() : tag.startsWith('&') ? tag.slice(1).trim() : tag
    const value = name === '.' ? frame?.value : lookup(frame, name)
    if (value !== null && value !== undefined) {
      const text = String(value)
      out += triple || tag.startsWith('&') ? text : escapeHtml(text)
    }
    index = after
  }
  return { text: out, index }
}

function findSectionEnd(
  template: string,
  start: number,
  open: string,
  close: string,
  closer: string,
): { bodyEnd: number; next: number } {
  let depth = 1
  let cursor = start
  while (cursor < template.length) {
    const opening = template.indexOf(open, cursor)
    if (opening === -1) break
    if (open === '{{' && template.startsWith('{{{', opening)) {
      const tripleEnd = template.indexOf('}}}', opening + 3)
      if (tripleEnd === -1) break
      cursor = tripleEnd + 3
      continue
    }
    const closingTag = template.indexOf(close, opening + open.length)
    if (closingTag === -1) break
    const raw = template.slice(opening + open.length, closingTag)
    const tag = raw.trim()
    if (tag.startsWith('#') || tag.startsWith('^')) depth += 1
    if (tag.startsWith('/')) {
      depth -= 1
      if (depth === 0) {
        if (raw.startsWith('/')) {
          return { bodyEnd: opening, next: closingTag + close.length }
        }
      }
    }
    cursor = closingTag + close.length
  }
  const direct = template.indexOf(closer, start)
  if (direct !== -1) return { bodyEnd: direct, next: direct + closer.length }
  return { bodyEnd: template.length, next: template.length }
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return renderNodes(template, 0, '{{', '}}', { value: context, parent: null }).text
}

export const TEMPLATE_HELPERS = {
  toJson: (text: string, render: (text: string) => string): string => JSON.stringify(render(text)),
}

export function templateContextWithHelpers(context: Record<string, unknown>): Record<string, unknown> {
  return { ...context, helpers: TEMPLATE_HELPERS }
}
