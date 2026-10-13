import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../src/client/lib/sanitize-svg'

/**
 * The SVG sinks both draw markup the app did not write — a pasted Mermaid diagram and a stencil
 * preview stored in a library manifest — so this proves the shared pass keeps a diagram whole while
 * taking away the two things an SVG can do that a picture cannot: run a script and carry a handler.
 */
describe('sanitizeSvg', () => {
  it('drops a script element and every event handler', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' +
      '<rect width="10" height="10" onload="alert(1)" onclick="alert(1)"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onload')
    expect(clean).not.toContain('onclick')
    expect(clean).toContain('<rect')
  })

  it('drops a javascript: link but keeps an ordinary one', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<a href="javascript:alert(1)"><text>x</text></a>' +
      '<a href="https://example.com"><text>y</text></a></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('https://example.com')
  })

  it('keeps the pieces a Mermaid diagram is drawn from', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:#fff}</style>' +
      '<defs><marker id="arrow"><path d="M0 0L4 2"/></marker></defs>' +
      '<g class="node"><rect/><use xlink:href="#arrow"/>' +
      '<path d="M0 0L9 9" marker-end="url(#arrow)"/>' +
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject>' +
      '</g></svg>'
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('<style')
    expect(clean).toContain('<marker')
    expect(clean).toContain('<use')
    expect(clean).toContain('marker-end="url(#arrow)"')
    expect(clean).toContain('foreignObject')
    expect(clean).toContain('label')
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

  it('answers an empty string without invoking DOMPurify', () => {
    expect(sanitizeSvg('')).toBe('')
  })
})
