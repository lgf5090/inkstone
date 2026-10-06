import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import { initI18n } from '../../lib/i18n'
import { clearSlideHtmlCache, clearSlidePlanCache, hashContent, readSlideHtml, rememberSlideHtml, rememberSlidePlan, renderSlideSource, slideCacheKey, slideMarkup, slideSettingFlags } from './slide-html'
import { SLIDE_DESIGN_HEIGHT, SLIDE_DESIGN_WIDTH, SLIDE_PAD_X, SLIDE_PAD_Y, measureStage } from './slide-stage'
import { SlidePreflight } from './slide-preflight'
import type { SlidePlan } from './slide-pagination'

installTestGlobals()

// Drawing a page's diagrams is what the pass is waiting for, so the enhancement is made to hang here:
// a case that passed only because the stubbed chain happened to finish inside the wait window would
// prove nothing about what the pass refuses to measure. The canvas's own two diagram renders are
// stubbed to succeed at once — they are what turns a measured page into a *drawn* one, and loading
// mermaid and chart.js into jsdom to say so would only make the answer depend on the stub. `hold`
// lets one case stop the diagram pass part-way and say what the pass does while it waits.
const diagram = vi.hoisted(() => ({ hold: null as Promise<void> | null }))

vi.mock('../../lib/markdown/enhance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/enhance')>()
  return {
    ...actual,
    enhancePreview: () => new Promise<void>(() => { }),
    renderPendingMermaid: () => Promise.resolve(),
    renderPendingCharts: () => diagram.hold ?? Promise.resolve(),
  }
})

// The background pass draws a slide off-screen, measures its pages, and hands the measured markup to
// the slide list. What it must never do is publish a capture of markup that had not finished being
// drawn: the list then shows a page of placeholders forever, because a page marked prepared is left
// alone. That is L-1's four reds, and this file is the evidence that pins it.
const metrics = measureStage(SLIDE_DESIGN_WIDTH, SLIDE_DESIGN_HEIGHT)
const CONTENT_WIDTH = SLIDE_DESIGN_WIDTH - SLIDE_PAD_X * 2
const CONTENT_HEIGHT = SLIDE_DESIGN_HEIGHT - SLIDE_PAD_Y * 2
const SLIDE = '# Chart page\n\n```chart\n{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}\n```'
const DECK = [SLIDE]
const HASHES = DECK.map((slide) => hashContent(slide))

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  // Both caches outlive a component, and the pass reads a measured plan as "this slide is already
  // listed" — without clearing them the second case would start from the first one's leftovers.
  clearSlideHtmlCache()
  clearSlidePlanCache()
})

// A pass that is still mounted keeps walking the shared cache on its own timers, so every case has to
// put its instance down — including the ones whose assertion throws first.
let live: { unmount: () => void } | null = null

afterEach(() => {
  live?.unmount()
  live = null
  document.body.innerHTML = ''
})

function keyFor(index: number): string {
  const dark = (document.documentElement.dataset.theme ?? 'dark') === 'dark'
  return slideCacheKey({ fingerprint: HASHES[index], dark, index, contentWidth: CONTENT_WIDTH, contentHeight: CONTENT_HEIGHT })
}

function seed(markup: Parameters<typeof rememberSlideHtml>[1]) {
  rememberSlideHtml(keyFor(0), markup)
}

// The entry the preparer writes before the enhancement chain has run — a plain render, parked in the
// cache so a reader has the slide's text while its diagrams are still being drawn.
function plainEntry() {
  return slideMarkup(renderSlideSource(SLIDE))
}

async function runPass(onPlan: (slide: number, plan: SlidePlan) => void, onProgress: (progress: unknown) => void = vi.fn()) {
  const view = renderElement(createElement(SlidePreflight, {
    deck: DECK,
    hashes: HASHES,
    cacheKeys: DECK.map((_, index) => keyFor(index)),
    fingerprint: 'pass-fingerprint',
    metrics,
    content: SLIDE,
    noteTitle: 'Chart page',
    onPlan,
    onProgress,
  }))
  // The pass starts on an idle slice with a deliberate gap, so give it a few of those rather than
  // asserting on the frame right after mount.
  for (let beat = 0; beat < 12; beat++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    if (document.querySelector('[data-slide-preflight]')) break
  }
  live = view
  return view
}

describe('SlidePreflight — what a measurement is allowed to be taken from', () => {
  it('does not measure, or promote, a plain render that is still being drawn', async () => {
    seed(plainEntry())
    const onPlan = vi.fn()
    const view = await runPass(onPlan)
    expect(document.querySelector('[data-slide-preflight]'), 'an undrawn page is not a geometry to measure').toBeNull()
    expect(onPlan).not.toHaveBeenCalled()
    expect(readSlideHtml(keyFor(0))?.prepared, 'the pass must not stamp a capture it never had the right to take').toBeFalsy()
    view.unmount()
  })

  it('mounts once the page has been through the enhancement chain', async () => {
    seed({ ...plainEntry(), prepared: true })
    const onPlan = vi.fn()
    const view = await runPass(onPlan)
    expect(document.querySelector('[data-slide-preflight]'), 'a prepared page is exactly what the pass is waiting for').toBeTruthy()
    view.unmount()
  })

  it('mounts on a page whose enhancement failed, because that is what the projector shows too', async () => {
    seed({ ...plainEntry(), failed: true })
    const view = await runPass(vi.fn())
    expect(document.querySelector('[data-slide-preflight]')).toBeTruthy()
    view.unmount()
  })
})

// A page can be *measured* and still not be *drawn*: the plan cache is keyed by the slide's text alone,
// so it outlives the theme and the box the markup was drawn for, and the capture the pass files is only
// as good as the moment it was taken. These three are the difference between the two words (L-1).
describe('SlidePreflight — a page is listed only once its drawings answered', () => {
  it('measures a page again when its plan is cached but its diagrams were never drawn', async () => {
    // The plan cache and the markup cache are two keys for one question. A page listed yesterday by a
    // pass that tore its canvas down before the chart landed is still yesterday's page: the list paints
    // whatever the entry holds, so a cached plan must not read as a finished capture (L-1).
    rememberSlidePlan(HASHES[0] ?? '', { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] })
    seed({ ...plainEntry(), prepared: true })
    const view = await runPass(vi.fn())
    expect(document.querySelector('[data-slide-preflight]'), 'a page count measured before is not a page drawn now').toBeTruthy()
    view.unmount()
  })

  it('lists a page again when its capture was drawn for settings the account has since turned', async () => {
    // The flags an entry names are part of what "already listed" means: a plan measured and a page drawn
    // under `math` on say nothing about the deck the presenter is now showing with it off (L-16).
    rememberSlidePlan(HASHES[0] ?? '', { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] })
    seed({ ...plainEntry(), prepared: true, drawn: true, flags: 'drawn-for-other-settings' })
    const onProgress = vi.fn()
    const view = await runPass(vi.fn(), onProgress)
    const measured = () => (onProgress.mock.calls.at(-1)?.[0] as { measured: number } | undefined)?.measured ?? -1
    expect(measured(), 'a page drawn for the other settings is not listed for these').toBe(0)
    view.unmount()
  })

  it('marks the entry it hands the list drawn, because that is what the list paints', async () => {
    seed({ ...plainEntry(), prepared: true })
    const view = await runPass(vi.fn())
    for (let beat = 0; beat < 12 && readSlideHtml(keyFor(0))?.drawn !== true; beat++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
    }
    expect(readSlideHtml(keyFor(0))?.drawn, 'the capture the pass took is the markup the list shows').toBe(true)
    view.unmount()
  })

})

// A flip of the account's display settings invalidates the markup every page was drawn from, so it has
// to invalidate the listing too: the pass restarts and walks the deck again. Without that, a page
// re-prepared under the new settings keeps the old capture and the old page count for the rest of the
// show — which is what the projector scenario in `scripts/e2e-visual.mjs` measures from the other side
// (L-17).
describe('SlidePreflight — what a settings flip does to a pass that finished', () => {
  const currentFlags = () => slideSettingFlags(useSession.getState().settings.preview)

  it('starts the listing over when the account turns a display switch', async () => {
    rememberSlidePlan(HASHES[0] ?? '', { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] })
    seed({ ...plainEntry(), prepared: true, drawn: true, flags: currentFlags() })
    const onProgress = vi.fn()
    const view = await runPass(vi.fn(), onProgress)
    const measured = () => (onProgress.mock.calls.at(-1)?.[0] as { measured: number } | undefined)?.measured ?? -1
    expect(measured(), 'a plan-cached page whose markup is drawn is already listed').toBe(1)

    act(() => {
      const preview = useSession.getState().settings.preview
      useSession.setState((state) => ({ ...state, settings: { ...state.settings, preview: { ...preview, mermaid: !preview.mermaid } } }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(measured(), 'the flip invalidates the markup, so it invalidates the listing with it').toBe(0)
    view.unmount()
  })

  it('measures a page whose markup lands while the pass is already waiting on it', async () => {
    // The projector and the pass are two components over one cache: the room's own page is re-prepared
    // by the projector while the pass sits pointing at it, and a cache read taken during render cannot
    // see a write that lands between two renders. That page was then stall-skipped without ever being
    // measured, so its capture never came back — the browser reading behind L-17, reproduced here by
    // doing the projector's write from the case.
    rememberSlidePlan(HASHES[0] ?? '', { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] })
    seed({ ...plainEntry(), prepared: true, drawn: true, flags: 'drawn-for-other-settings' })
    const onProgress = vi.fn()
    const view = await runPass(vi.fn(), onProgress)
    const measured = () => (onProgress.mock.calls.at(-1)?.[0] as { measured: number } | undefined)?.measured ?? -1
    expect(measured(), 'a page drawn for the other settings is not listed for these').toBe(0)

    act(() => {
      seed({ ...plainEntry(), prepared: true, flags: currentFlags() })
    })
    for (let beat = 0; beat < 12 && readSlideHtml(keyFor(0))?.drawn !== true; beat++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
    }
    expect(document.querySelector('[data-slide-preflight]'), 'the markup that landed is the page the pass was waiting for').toBeTruthy()
    expect(readSlideHtml(keyFor(0))?.drawn, 'and the pass takes its capture back').toBe(true)
    view.unmount()
  })
})

// A tab that is not showing is given no animation frames, and the pass asked for one before mounting its
// canvas: measured on a hidden show tab, zero frames in two seconds while its own timers kept firing, so
// the page it was pointing at was taken by the four-second stall guard and never revisited (L-17).
describe('SlidePreflight — what the pass does when no frame is coming', () => {
  it('mounts its canvas on a timer when the tab gives it no frames', async () => {
    const frame = window.requestAnimationFrame
    const cancel = window.cancelAnimationFrame
    let asked = 0
    window.requestAnimationFrame = () => { asked += 1; return 0 }
    window.cancelAnimationFrame = () => {}
    try {
      seed({ ...plainEntry(), prepared: true })
      const view = await runPass(vi.fn())
      expect(asked, 'the mount did ask for a frame, and none was coming').toBeGreaterThan(0)
      expect(document.querySelector('[data-slide-preflight]'), 'and it mounted anyway, off the fallback timer').toBeTruthy()
      view.unmount()
    } finally {
      window.requestAnimationFrame = frame
      window.cancelAnimationFrame = cancel
    }
  })
})

// One page of the queue, held open on purpose: the pass must neither list it nor walk past it while the
// canvas's diagram pass is out — the two halves of the same answer, seen from the queue.
describe('SlidePreflight — what the pass does while a page is still being drawn', () => {
  it('holds the page open while its diagram pass is out, and lists it once it answers', async () => {
    // The pass captures what the page holds at the moment it reports, so a cursor that moved on the
    // first report would leave the slide list holding a page of placeholders — and the entry would
    // say `prepared`, which is why the drawn answer has to come from the canvas that drew.
    let releaseDiagrams!: () => void
    diagram.hold = new Promise<void>((resolve) => {
      releaseDiagrams = resolve
    })
    try {
      seed({ ...plainEntry(), prepared: true })
      const onPlan = vi.fn()
      const onProgress = vi.fn()
      const view = await runPass(onPlan, onProgress)
      expect(onPlan, 'the page count is measured from the report that came first').toHaveBeenCalled()
      expect(readSlideHtml(keyFor(0))?.drawn, 'a page whose diagrams are still out is not drawn').toBeFalsy()
      const progress = () => (onProgress.mock.calls.at(-1)?.[0] as { measured: number } | undefined)?.measured ?? -1
      expect(progress(), 'the pass does not walk on while a page is still being drawn').toBe(0)
      await act(async () => {
        releaseDiagrams()
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      expect(readSlideHtml(keyFor(0))?.drawn, 'the settled report is the one that fills the entry in').toBe(true)
      expect(progress(), 'and the page counts as listed only from then on').toBe(1)
      view.unmount()
    } finally {
      diagram.hold = null
    }
  })
})
