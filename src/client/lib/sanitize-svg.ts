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
 * `style` is the one thing a document pipeline would forbid that a diagram cannot lose — Mermaid and
 * the drawing engine both paint with inline styles and a `<style>` block inside the SVG — and
 * DOMPurify sanitises the declarations themselves rather than trusting them, so it is kept.
 */
import DOMPurify from 'dompurify'
import { PURIFY_CONFIG } from './markdown/renderer'

// Layered on the shared document config so its forbidden tag and attribute lists keep applying to
// diagram markup — the labels Mermaid draws are HTML, and a `<form>` pasted into one is still a form.
const SVG_PURIFY_CONFIG = {
  ...PURIFY_CONFIG,
  // Neither tag is in DOMPurify's lists at all, and both are part of an exported diagram: `use` draws
  // markers and clones, `foreignObject` is the element an HTML label is held in.
  ADD_TAGS: [...PURIFY_CONFIG.ADD_TAGS, 'foreignObject', 'use'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: PURIFY_CONFIG.FORBID_TAGS.filter((tag) => tag !== 'style'),
  FORBID_ATTR: PURIFY_CONFIG.FORBID_ATTR.filter((attr) => attr !== 'style'),
}

/** The one pass every diagram sink shares; an empty string is answered without touching DOMPurify. */
export function sanitizeSvg(svg: string): string {
  if (!svg) return ''
  return DOMPurify.sanitize(svg, SVG_PURIFY_CONFIG)
}
