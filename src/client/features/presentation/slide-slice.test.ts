import { describe, expect, it, vi } from 'vitest'
import { captureSlideHtml, slicePageHtml } from './slide-html'
import type { SlidePlan } from './slide-pagination'

const SLIDE = '<p>one</p><p>two</p><h2>three</h2><p>four</p>'
const plan: SlidePlan = {
  pages: [
    { from: 0, to: 2, top: 0 },
    { from: 2, to: 4, top: 300 },
  ],
  scales: [1, 1, 1, 0.5],
}

const CONTENT_WIDTH = 1168
const CONTENT_HEIGHT = 632

// The plan a 1 800px-tall block gets when the walk continues it on its own units instead of
// shrinking it below what a projector can read.
const continued: SlidePlan = {
  pages: [
    { from: 0, to: 1, top: 0, clip: { top: 0, bottom: 1200 } },
    { from: 0, to: 1, top: 600, clip: { top: 600, bottom: 600 } },
    { from: 0, to: 1, top: 1200, clip: { top: 1200, bottom: 0 } },
  ],
  scales: [1],
}

describe('slicePageHtml', () => {
  it('keeps only the blocks the requested page owns', () => {
    expect(slicePageHtml(SLIDE, plan, 0, CONTENT_WIDTH, CONTENT_HEIGHT)).toBe('<p>one</p><p>two</p>')
    expect(slicePageHtml(SLIDE, plan, 1, CONTENT_WIDTH, CONTENT_HEIGHT)).toBe('<h2>three</h2><p style="transform-origin: top left; transform: scale(0.5); width: 2336px; height: 1264px; overflow: hidden;">four</p>')
  })

  it('carries the shrink factor of a block that owns a page by itself', () => {
    const tall: SlidePlan = { pages: [{ from: 0, to: 1, top: 0 }], scales: [0.25] }
    const html = slicePageHtml('<div>tall</div>', tall, 0, CONTENT_WIDTH, CONTENT_HEIGHT)
    expect(html).toContain('scale(0.25)')
    expect(html).toContain(`width: ${CONTENT_WIDTH / 0.25}px`)
  })

  it('clamps a page index past the end instead of dropping the page', () => {
    expect(slicePageHtml(SLIDE, plan, 7, CONTENT_WIDTH, CONTENT_HEIGHT)).toBe(slicePageHtml(SLIDE, plan, 1, CONTENT_WIDTH, CONTENT_HEIGHT))
  })

  // A continued block has no wrapper to translate on a slice surface: the projector moves the whole
  // slide by the page's `top`, while a card or a printed page only ever gets this one block, which
  // starts at the top of its own box. So the band has to travel with the block, or the page would
  // paint its own band 600px down and cut its tail off at the box.
  describe.each([
    [0, 'inset(0px 0 1200px 0)', undefined],
    [1, 'inset(600px 0 600px 0)', 'translateY(-600px)'],
    [2, 'inset(1200px 0 0px 0)', 'translateY(-1200px)'],
  ])('page %i of a continued table', (sub, clip, shift) => {
    it(`cuts the block to its band${shift ? ' and lifts it to the top of the page' : ''}`, () => {
      const html = slicePageHtml('<table>rows</table>', continued, sub, CONTENT_WIDTH, CONTENT_HEIGHT)
      expect(html).toContain(`clip-path: ${clip}`)
      expect(shift ? html.includes(shift) : !html.includes('transform')).toBe(true)
    })
  })

  it('falls back to the whole slide when there is no plan yet', () => {
    expect(slicePageHtml(SLIDE, { pages: [], scales: [] }, 0, CONTENT_WIDTH, CONTENT_HEIGHT)).toBe(SLIDE)
  })

  it('ignores markup positions the measured slide no longer has', () => {
    const stale: SlidePlan = { pages: [{ from: 3, to: 9, top: 0 }], scales: [1, 1, 1, 1] }
    expect(slicePageHtml(SLIDE, stale, 0, CONTENT_WIDTH, CONTENT_HEIGHT)).toBe('<p>four</p>')
  })
})

// The measuring canvas hands back what it captured, and every other surface renders from that:
// the projector draws live charts again, the list and the printed deck show the still.
function measuredPage(markup: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = `<div data-slide-page>${markup}</div>`
  return host
}

const CHART = '<div class="chartjs-block" data-chart="%7B%7D" data-rendered="l:2:abc"><div class="chartjs-container"><canvas></canvas></div></div>'
const DIAGRAM = '<div class="mermaid-block" data-mermaid="%7B%7D" data-rendered="l:2:abc"><svg></svg></div>'

describe('captureSlideHtml', () => {
  it('drops the chart marker that would otherwise hand an empty canvas to every later mount', () => {
    const captured = captureSlideHtml(measuredPage(CHART))
    expect(captured).not.toContain('data-rendered')
    expect(captured).toContain('data-chart')
  })

  it('keeps the still of the chart, so the slide list and the printed deck have a picture', () => {
    const host = measuredPage(CHART)
    vi.spyOn(host.querySelector('canvas')!, 'toDataURL').mockReturnValue('data:image/png;base64,still')
    const captured = captureSlideHtml(host)
    expect(captured).toContain('data:image/png;base64,still')
    expect(captured).not.toContain('<canvas')
  })

  it('keeps a diagram marker, because the cached copy is hydrated instead of re-rendered', () => {
    expect(captureSlideHtml(measuredPage(DIAGRAM))).toContain('data-rendered="l:2:abc"')
  })

  it('leaves the markup it measured untouched', () => {
    const host = measuredPage(CHART)
    vi.spyOn(host.querySelector('canvas')!, 'toDataURL').mockReturnValue('data:image/png;base64,still')
    captureSlideHtml(host)
    expect(host.innerHTML).toContain('data-rendered')
    expect(host.innerHTML).toContain('<canvas')
  })

  it('reports nothing to capture when no measured page is mounted', () => {
    expect(captureSlideHtml(null)).toBeNull()
    expect(captureSlideHtml(document.createElement('div'))).toBeNull()
  })
})
