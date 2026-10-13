/**
 * Making a diagram's SVG safe to put into the page.
 *
 * Two surfaces here draw markup that is not the app's own: a Mermaid diagram the reader pasted into
 * the text-to-diagram dialog, and a stencil preview whose SVG was rendered elsewhere and stored in a
 * library manifest the server hands back. Both arrive as an SVG string and both are handed to
 * React's `dangerouslySetInnerHTML`, so both go through this one pass first. An SVG is a document
 * that can carry a script and an event handler exactly as HTML can, and neither surface may trust
 * where its markup came from, so the config is written for SVG alone: the SVG profile keeps the
 * shape elements and filters a diagram is drawn from, while the HTML profile stays off.
 *
 * `style` is the one thing a document pipeline would forbid that a diagram cannot lose — Mermaid and
 * the drawing engine both paint with inline styles and a `<style>` block inside the SVG — and
 * DOMPurify sanitises the declarations themselves rather than trusting them, so it is kept.
 */
import DOMPurify from 'dompurify'

const CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Both are part of an exported diagram — `use` draws markers and clones, `foreignObject` holds an
  // HTML label — and neither is in the SVG profile by default, so they are added back explicitly.
  ADD_TAGS: ['foreignObject', 'use'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
}

/** The one pass both diagram sinks share; an empty string is answered without touching DOMPurify. */
export function sanitizeSvg(svg: string): string {
  if (!svg) return ''
  return DOMPurify.sanitize(svg, CONFIG)
}
