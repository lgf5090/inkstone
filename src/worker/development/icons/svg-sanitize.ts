import { ApiError } from '../../lib/errors'

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'use', 'symbol', 'title', 'desc', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern', 'filter', 'fegaussianblur', 'feoffset', 'feblend',
  'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode', 'feboxblur',
])

const ALLOWED_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'offset', 'stop-color',
  'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'clippathunits',
  'maskunits', 'id', 'class', 'clip-path', 'clip-rule', 'marker-end', 'marker-start',
  'marker-mid', 'href', 'xlink:href', 'preserveaspectratio', 'vector-effect',
])

const FORBIDDEN_PATTERN = /<\s*(script|foreignobject|iframe|object|embed|audio|video|image|a|animate|set|discard)\b|<!doctype|<!entity|<\?xml-stylesheet|javascript:|data:|vbscript:|expression\s*\(|@import/i
const URL_PATTERN = /url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi
const EVENT_ATTRIBUTE = /\bon[a-z]+\s*=/i
const MAX_DEPTH = 64
const MAX_ELEMENTS = 5000

function balanced(text: string): boolean {
  let depth = 0
  for (const match of text.matchAll(/<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*)?\/?>/g)) {
    const close = match[0].startsWith('</')
    const selfClosing = match[0].endsWith('/>')
    if (close) depth -= 1
    else if (!selfClosing) depth += 1
    if (depth < 0) return false
    if (depth > MAX_DEPTH) return false
  }
  return depth === 0
}

function checkAttributes(text: string): void {
  const tagPattern = /<\/?([A-Za-z][\w:-]*)(\s[^<>]*)?\/?>/g
  let tag: RegExpMatchArray | null
  while ((tag = tagPattern.exec(text))) {
    const name = (tag[1] ?? '').toLowerCase()
    if (!ALLOWED_TAGS.has(name)) throw ApiError.badRequest('The SVG contains an unsupported element')
    const attrs = tag[2] ?? ''
    if (EVENT_ATTRIBUTE.test(attrs)) throw ApiError.badRequest('The SVG contains an event handler')
    const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let attr: RegExpMatchArray | null
    while ((attr = attrPattern.exec(attrs))) {
      const key = (attr[1] ?? '').toLowerCase()
      const value = attr[2] ?? attr[3] ?? ''
      if (!ALLOWED_ATTRIBUTES.has(key)) throw ApiError.badRequest('The SVG contains an unsupported attribute')
      if (key === 'href' || key === 'xlink:href') {
        if (!value.startsWith('#')) throw ApiError.badRequest('The SVG contains an external reference')
      }
      if (/^\s*(javascript|data|vbscript):/i.test(value)) throw ApiError.badRequest('The SVG contains an unsafe URL')
    }
  }
}

export function sanitizeSvgText(input: string, maxBytes: number): string {
  const text = input.trim()
  if (!text) throw ApiError.badRequest('The SVG is empty')
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw ApiError.badRequest('The SVG is too large')
  if (!/^<svg[\s>]/i.test(text)) throw ApiError.badRequest('The SVG root element is missing')
  if (FORBIDDEN_PATTERN.test(text)) throw ApiError.badRequest('The SVG contains a forbidden element or URL')
  if (!balanced(text)) throw ApiError.badRequest('The SVG is not well formed')
  if ((text.match(/<[A-Za-z]/g) ?? []).length > MAX_ELEMENTS) throw ApiError.badRequest('The SVG has too many elements')
  checkAttributes(text)
  for (const match of text.matchAll(URL_PATTERN)) {
    const value = match[2] ?? ''
    if (!value.startsWith('#')) throw ApiError.badRequest('The SVG contains an external URL reference')
  }
  return text
}
