import { act, createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { createFenceBodies, findFenceBodies, takeFenceIndex } from '../../lib/markdown/fence-bodies'
import { clearSlideHtmlCache, hashContent, rememberSlideHtml, renderSlideSource, slideCacheKey } from './slide-html'
import { SlideCanvas, applySlidePage, prefersReducedMotion, useSlideFenceBodies, useSlideLinkInterceptor } from './slide-canvas'
import type { SlidePlan } from './slide-pagination'

// The plain render is what this file counts: the spy wraps the real function so every other case
// here still renders markup the way the canvas does, and only the call count is observable.
const renderSlideSourceMock = vi.mocked(renderSlideSource)
vi.mock('./slide-html', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./slide-html')>()
  return { ...actual, renderSlideSource: vi.fn(actual.renderSlideSource) }
})

// The canvas's two diagram renders are the whole of what "settled" means, so they are stubbed where
// reading them needs a promise the case controls: `hold` stops the pass mid-flight, `failMermaid`
// makes it throw. Neither touches the other cases here, none of which draw a diagram.
const diagram = vi.hoisted(() => ({ hold: null as Promise<void> | null, failMermaid: false }))

vi.mock('../../lib/markdown/enhance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/enhance')>()
  return {
    ...actual,
    renderPendingMermaid: () => (diagram.failMermaid ? Promise.reject(new Error('mermaid refused the page')) : Promise.resolve()),
    renderPendingCharts: () => diagram.hold ?? Promise.resolve(),
  }
})

function mountCanvas(onPlan: (plan: unknown, settled: boolean) => void) {
  return renderElement(createElement(SlideCanvas, {
    cacheKey: CACHED_KEY,
    source: CACHED_SOURCE,
    subPage: 0,
    onPlan,
    contentWidth: 1120,
    contentHeight: 630,
  }))
}

/** Runs beats until the predicate answers, and says which way it finished. */
async function waitUntil(predicate: () => boolean, tries = 20): Promise<boolean> {
  for (let beat = 0; beat < tries && !predicate(); beat++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }
  return predicate()
}

const reported = (onPlan: ReturnType<typeof vi.fn>, settled: boolean) =>
  onPlan.mock.calls.some((call) => (call as [unknown, boolean])[1] === settled)

describe('prefersReducedMotion', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('returns true when media query prefers-reduced-motion matches', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    expect(prefersReducedMotion()).toBe(true)
  })

  it('returns false when prefers-reduced-motion does not match', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('useSlideFenceBodies', () => {
  it('registers the fence set the markup was built from on the canvas host', () => {
    const fences = createFenceBodies()
    takeFenceIndex(fences, 'kanban', '## Column\n\n- [ ] Card')

    function Harness() {
      const hostRef = useRef<HTMLDivElement>(null)
      const html = '<div class="kanban-block" data-kanban="" data-kanban-index="0"><div class="kanban-block-placeholder">Loading kanban…</div></div>'
      useSlideFenceBodies(hostRef, html, fences)
      return createElement('div', { ref: hostRef, dangerouslySetInnerHTML: { __html: html } })
    }

    const rendered = renderElement(createElement(Harness))
    const block = rendered.container.querySelector<HTMLElement>('[data-kanban]')
    expect(block).not.toBeNull()
    // This fork's `enhancePreview` takes no fence set, so a board reads its body back off the host.
    // Without this registration the projector shows an empty fence for a note that has a board on it.
    expect(findFenceBodies(block!)).toBe(fences)
    rendered.unmount()
  })
})

// The projector shows a continued block by translating the whole slide to the band's offset; the
// band itself has to be cut, or the rows belonging to the next page would be drawn on this one too.
describe('applySlidePage — a block that continues over pages', () => {
  const plan: SlidePlan = {
    pages: [
      { from: 0, to: 1, top: 0, clip: { top: 0, bottom: 1200 } },
      { from: 0, to: 1, top: 600, clip: { top: 600, bottom: 600 } },
      { from: 0, to: 1, top: 1200, clip: { top: 1200, bottom: 0 } },
    ],
    scales: [1],
  }
  const blocks = () => [document.createElement('table'), document.createElement('p')]

  it('cuts the block to the band its page owns and hides the block below it', () => {
    const [table, paragraph] = blocks()
    applySlidePage([table, paragraph], plan, 1, 1168, 632)
    expect(table.style.clipPath).toBe('inset(600px 0 600px 0)')
    expect(table.style.visibility).toBe('')
    expect(paragraph.style.visibility).toBe('hidden')
    expect(paragraph.style.clipPath).toBe('')
  })

  it('leaves a band that opens the block whole at the top and cuts only its tail', () => {
    const [table] = blocks()
    applySlidePage([table], plan, 0, 1168, 632)
    expect(table.style.clipPath).toBe('inset(0px 0 1200px 0)')
  })

  it('clears the band when the page shown no longer continues a block', () => {
    const [table] = blocks()
    applySlidePage([table], plan, 2, 1168, 632)
    applySlidePage([table], { pages: [{ from: 0, to: 1, top: 0 }], scales: [1] }, 0, 1168, 632)
    expect(table.style.clipPath).toBe('')
  })
})

// The projector swallows the click on every link in the slide, so a refused href used to leave the
// author with nothing at all: no navigation and no browser feedback, only a slide that ignores them.
describe('useSlideLinkInterceptor', () => {
  function LinkHarness({ href }: { href: string }) {
    const handleClick = useSlideLinkInterceptor()
    return createElement('div', { onClick: handleClick }, createElement('a', { href }, 'the link'))
  }

  let open: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    open.mockRestore()
    useUi.setState({ toasts: [] })
  })

  function clickAnchor(href: string) {
    open = vi.spyOn(window, 'open').mockImplementation(() => null)
    useUi.setState({ toasts: [] })
    const rendered = renderElement(createElement(LinkHarness, { href }))
    act(() => { rendered.container.querySelector('a')?.click(); })
    rendered.unmount()
    return open
  }

  it('tells the presenter a link was refused instead of ignoring the click', () => {
    clickAnchor('javascript:alert(1)')
    const toasts = useUi.getState().toasts
    expect(toasts.map((toast) => toast.title)).toContain(t('workspace.presentation_link_blocked'))
    expect(toasts.at(-1)?.tone).toBe('warning')
  })

  it('opens a link whose scheme is only written in capitals, and does not announce it', () => {
    const openMock = clickAnchor('HTTPS://Example.COM/Talk#Section')
    expect(openMock).toHaveBeenCalledWith('HTTPS://Example.COM/Talk#Section', '_blank', 'noopener,noreferrer')
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('stays quiet about a jump that belongs to the slide', () => {
    const openMock = clickAnchor('#slide-heading')
    expect(openMock).not.toHaveBeenCalled()
    expect(useUi.getState().toasts).toHaveLength(0)
  })
})


// N-25: the plain markdown render covers the first paint before the prepared markup lands. Once the
// cache holds this slide, running it again is work whose result is thrown away — and the measuring
// pass walks slide after slide it has *just* prepared, so the waste is per page, mid-talk.
const CACHED_SOURCE = '# Prepared\n\nThere is nothing to render twice here.'
const CACHED_KEY = slideCacheKey({ fingerprint: hashContent(CACHED_SOURCE), dark: false, index: 0, contentWidth: 1120, contentHeight: 630 })

function mountPreparedCanvas() {
  return renderElement(createElement(SlideCanvas, {
    cacheKey: CACHED_KEY,
    source: CACHED_SOURCE,
    subPage: 0,
    onPlan: vi.fn(),
    contentWidth: 1120,
    contentHeight: 630,
  }))
}

beforeEach(() => {
  renderSlideSourceMock.mockClear()
  clearSlideHtmlCache()
})

describe('SlideCanvas — a cache hit renders nothing twice', () => {
  it('takes the prepared markup without running the plain render at all', () => {
    rememberSlideHtml(CACHED_KEY, { html: '<h1>Prepared</h1>', fences: createFenceBodies() })

    const view = mountPreparedCanvas()

    expect(view.container.textContent).toContain('Prepared')
    expect(renderSlideSourceMock).not.toHaveBeenCalled()
    view.unmount()
  })

  it('renders the source exactly once while nothing is prepared yet', () => {
    const view = mountPreparedCanvas()

    expect(renderSlideSourceMock).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})

// The memo has to re-run when the prepared markup arrives mid-paint — that is what the measuring pass
// does to a slide the presenter is already looking at.
describe('SlideCanvas — the prepared markup landing after the first paint', () => {
  it('switches to it without rendering the source a second time', () => {
    const view = mountPreparedCanvas()

    act(() => {
      rememberSlideHtml(CACHED_KEY, { html: '<h1>Prepared later</h1>', fences: createFenceBodies() })
    })

    expect(view.container.textContent).toContain('Prepared later')
    expect(renderSlideSourceMock).toHaveBeenCalledTimes(1)
    view.unmount()
  })
})

// The background pass advances on the canvas's own report, and a report taken before that page's
// diagram pass is a report about a page of placeholders. The two halves are told apart at the only
// place that knows whether the drawing finished (L-1).
describe('SlideCanvas — the report a page is measured by', () => {
  it('reports the measured page unsettled first and says so once its diagrams are through', async () => {
    rememberSlideHtml(CACHED_KEY, { html: '<h1>Prepared</h1>', fences: createFenceBodies() })
    const onPlan = vi.fn()
    const view = mountCanvas(onPlan)
    expect(reported(onPlan, false), 'a measured page is reported before anything is drawn').toBe(true)
    expect(await waitUntil(() => reported(onPlan, true)), 'the canvas says the page is settled once its own pass is over').toBe(true)
    view.unmount()
  })

  it('takes back the settled answer when a different page arrives under it', async () => {
    // The pass holds one canvas while the show turns, and the preflight swaps pages the same way. A
    // flag that stayed up across the swap would let the next capture be filed as drawn before the new
    // page had been drawn at all — which is the defect, seen from the other side.
    rememberSlideHtml(CACHED_KEY, { html: '<h1>First</h1>', fences: createFenceBodies() })
    const onPlan = vi.fn()
    const view = mountCanvas(onPlan)
    expect(await waitUntil(() => reported(onPlan, true))).toBe(true)
    let release!: () => void
    diagram.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      onPlan.mockClear()
      act(() => {
        rememberSlideHtml(CACHED_KEY, { html: '<h1>Second</h1>', fences: createFenceBodies() })
      })
      expect(await waitUntil(() => reported(onPlan, false)), 'the swapped page is reported before its own pass').toBe(true)
      expect(reported(onPlan, true), 'and nothing about it is settled while its diagrams are held').toBe(false)
      release()
      expect(await waitUntil(() => reported(onPlan, true)), 'the swapped page settles on its own terms').toBe(true)
    } finally {
      diagram.hold = null
    }
    view.unmount()
  })

})

// The cache is one store for the stage, the list and the export, so "which settings was this page drawn
// under" has to be answered at every one of those reads (L-16).
describe('SlideCanvas — the settings a cached page answers for', () => {
  it('draws its own render of a page prepared under settings the account has turned off', () => {
    // The projector and the list read one cache, so the same rule that clears a card has to clear the
    // stage: an entry written under other settings is not this page (L-16).
    rememberSlideHtml(CACHED_KEY, { html: '<h1>Stale under these settings</h1>', fences: createFenceBodies(), prepared: true, flags: 'stale' })
    const view = mountCanvas(vi.fn())
    expect(view.container.textContent).not.toContain('Stale under these settings')
    expect(renderSlideSourceMock, 'the canvas renders the slide itself rather than showing another setting\'s page').toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('settles a page whose diagram threw, because nothing else is coming to finish it', async () => {
    diagram.failMermaid = true
    try {
      rememberSlideHtml(CACHED_KEY, { html: '<h1>Broken</h1>', fences: createFenceBodies() })
      const onPlan = vi.fn()
      const view = mountCanvas(onPlan)
      expect(await waitUntil(() => reported(onPlan, true)), 'a failed diagram still answers the waiting pass').toBe(true)
      view.unmount()
    } finally {
      diagram.failMermaid = false
    }
  })
})

// N-31: a stepped slide is the same measured page with one more axis — how far into it the projector
// has walked. Hiding stays on `visibility` for the same reason off-page blocks do: a chart.js diagram
// that was only hidden keeps its canvas, so revealing the next block never re-renders the last one.
describe('applySlidePage — the blocks a step has not reached yet', () => {
  const block = () => {
    const node = document.createElement('p')
    node.textContent = 'block'
    return node
  }
  const plan = (steps?: boolean) => ({ pages: [{ from: 0, to: 3, top: 0 }], scales: [1, 1, 1], steps })

  // The step counts reveals, so step 0 shows the block the page opens on and nothing after it.
  it('holds back every block past the step the show is on', () => {
    const children = [block(), block(), block()]
    applySlidePage(children, plan(true), 0, 1168, 632, 0)
    expect(children.map((child) => child.style.visibility)).toEqual(['', 'hidden', 'hidden'])
    applySlidePage(children, plan(true), 0, 1168, 632, 1)
    expect(children.map((child) => child.style.visibility)).toEqual(['', '', 'hidden'])
  })

  it('shows the whole page once the last step is reached', () => {
    const children = [block(), block(), block()]
    applySlidePage(children, plan(true), 0, 1168, 632, 2)
    expect(children.every((child) => child.style.visibility === '')).toBe(true)
  })

  it('leaves an unstepped slide showing everything on its page', () => {
    const children = [block(), block(), block()]
    applySlidePage(children, plan(), 0, 1168, 632, 0)
    expect(children.every((child) => child.style.visibility === '')).toBe(true)
  })

  it('still hides what belongs to another page, step or no step', () => {
    const children = [block(), block(), block()]
    applySlidePage(children, { pages: [{ from: 0, to: 2, top: 0 }, { from: 2, to: 3, top: 200 }], scales: [1, 1, 1], steps: true }, 1, 1168, 632, 0)
    expect(children.map((child) => child.style.visibility)).toEqual(['hidden', 'hidden', ''])
  })
})

// PR-M10: the projector should arrive on a new page the way the exported file does. The page element
// is reused from turn to turn, so this is the only place that can tell "a new page" from "the same
// page re-rendered" — and a stylesheet cannot tell it at all.
describe('the arrival of a page', () => {
  const animate = vi.fn()
  const originalAnimate = HTMLElement.prototype.animate
  const originalMatchMedia = window.matchMedia

  const canvasProps = (overrides: Record<string, unknown> = {}) => ({
    cacheKey: CACHED_KEY,
    source: CACHED_SOURCE,
    subPage: 0,
    onPlan: () => {},
    contentWidth: 1120,
    contentHeight: 630,
    ...overrides,
  })

  beforeEach(() => {
    animate.mockClear()
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate
  })
  afterEach(() => {
    HTMLElement.prototype.animate = originalAnimate
    window.matchMedia = originalMatchMedia
    vi.unstubAllGlobals()
  })

  it('fades the page in when it arrives, and not when it is merely redrawn', () => {
    const view = renderElement(createElement(SlideCanvas, canvasProps()))
    expect(animate).toHaveBeenCalledTimes(1)
    view.rerender(createElement(SlideCanvas, canvasProps({ subPage: 1 })))
    expect(animate).toHaveBeenCalledTimes(2)
    view.rerender(createElement(SlideCanvas, canvasProps({ subPage: 1 })))
    expect(animate, 'a re-render of the same page is not a new arrival').toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('gives no motion to a reader who asked for none', () => {
    window.matchMedia = ((query: string) => ({
      matches: /prefers-reduced-motion/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
    const view = renderElement(createElement(SlideCanvas, canvasProps()))
    expect(animate).not.toHaveBeenCalled()
    view.unmount()
  })
})
