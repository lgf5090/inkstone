/**
 * Making a diagram's SVG safe to put into the page.
 *
 * Three surfaces inject markup this app did not write: the Mermaid block a note renders, a diagram
 * the reader pasted into the text-to-diagram dialog, and a stencil preview whose SVG was rendered
 * elsewhere and stored in a library manifest the server hands back. All three arrive as an SVG string
 * and all three reach the DOM through `innerHTML` or `dangerouslySetInnerHTML`, so all three come
 * through this one pass. An SVG is a document that can carry a script and an event handler exactly as
 * HTML can, and none of these surfaces may trust where its markup came from.
 *
 * The config is the one the Mermaid renderer has always used — the shared document config with the two
 * tags a diagram needs added back — rather than a profile written for SVG alone: Mermaid labels its
 * nodes with HTML held in a `<foreignObject>`, so a profile whose tag list is only SVG would keep the
 * picture and drop the text drawn on it.
 *
 * A style element is document-scoped and is never safe inside a note. Inline styles are kept only
 * when every declaration belongs to the diagram geometry and typography allowlist below.
 */
import DOMPurify from 'dompurify'
import { PURIFY_CONFIG } from './markdown/renderer'

const SVG_PURIFY_CONFIG = {
  ...PURIFY_CONFIG,
  ADD_TAGS: [...PURIFY_CONFIG.ADD_TAGS, 'foreignObject', 'use'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
}

const SAFE_SVG_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'paint-order',
  'opacity', 'display', 'visibility', 'overflow', 'white-space', 'vertical-align',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'color', 'background-color',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'aspect-ratio',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'transform', 'transform-origin', 'vector-effect', 'clip-path', 'mask', 'filter',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color',
  'marker-start', 'marker-mid', 'marker-end', 'rx', 'ry', 'cx', 'cy', 'r', 'x', 'y',
])
const UNSAFE_SVG_STYLE_VALUE = /url\(\s*(?!#)|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|@import/i

function safeSvgStyle(value: string): boolean {
  const declarations = value.split(';').map((part) => part.trim()).filter(Boolean)
  return declarations.length > 0 && declarations.every((declaration) => {
    const colon = declaration.indexOf(':')
    if (colon <= 0) return false
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const declarationValue = declaration.slice(colon + 1).trim()
    return SAFE_SVG_STYLE_PROPERTIES.has(property)
      && declarationValue.length > 0
      && !UNSAFE_SVG_STYLE_VALUE.test(declarationValue)
  })
}

const svgPurify = typeof window === 'undefined' ? DOMPurify : DOMPurify(window)
svgPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && safeSvgStyle(data.attrValue)) data.forceKeepAttr = true
})

/** The one pass every diagram sink shares; an empty string is answered without touching DOMPurify. */
export function sanitizeSvg(svg: string): string {
  if (!svg) return ''
  return svgPurify.sanitize(svg, SVG_PURIFY_CONFIG)
}
