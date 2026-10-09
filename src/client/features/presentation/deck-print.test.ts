import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../lib/i18n'
import { createFenceBodies, takeFenceIndex, type FenceBodies } from '../../lib/markdown/fence-bodies'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { renderElement } from '../../lib/test-render'
import * as deckImage from './deck-image'
import { buildDeckPages, DeckHandoutSheet, DeckImageSheet, saveDeckPages } from './deck-print'
import { readSlideHtml, rememberSlideHtml, slideCacheKey, slideSettingFlags } from './slide-html'
import type { SlidePlan } from './slide-pagination'
import type { StageMetrics } from './slide-stage'

vi.mock('./deck-image', () => ({
  deckImageGeometry: vi.fn(() => ({ width: 1280, height: 720, padX: 0, padY: 0 })),
  collectDeckCss: vi.fn(async () => ''),
  renderDeckPagePng: vi.fn(async () => new Blob(['fake-png'], { type: 'image/png' })),
  zipDeckImages: vi.fn(async () => new Blob(['fake-zip'], { type: 'application/zip' })),
  saveDeckImages: vi.fn(),
}))

// The sheet's four drawing passes each reach for a vendor jsdom cannot run. They are replaced by
// markers that record the call, so "the sheet ran the pass" is an assertion rather than a guess out
// of what the block looks like afterwards.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => { },
    render: (_id: string, source: string) => Promise.resolve({ svg: `<svg class="stub-diagram"><desc>${source}</desc></svg>` }),
  },
}))

vi.mock('chart.js/auto', () => ({
  Chart: vi.fn(function construct(this: void) {
    return { destroy: vi.fn(), resize: vi.fn(), update: vi.fn() }
  }),
}))

const mindmapDraws = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../lib/markdown/mindmap/static', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/markdown/mindmap/static')>()
  return {
    ...actual,
    renderStaticMindmaps: vi.fn((root: HTMLElement) => {
      mindmapDraws.calls += 1
      for (const node of root.querySelectorAll<HTMLElement>('[data-mindmap]')) {
        node.classList.remove('loading')
        node.innerHTML = '<svg class="stub-map"></svg>'
      }
      return Promise.resolve()
    }),
  }
})

// The sheet reports its own progress and toasts when it is done, so the store is stood up rather
// than imported: a test of the export's lifecycle should not depend on the toast queue's timers.
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))


// The sheet reports its own page count to whoever asked for the export; tests that do not care about it
// hand over a sink.
const NO_PROGRESS = () => {}

const METRICS: StageMetrics = { scale: 1, designWidth: 1280, designHeight: 720, contentWidth: 1168, contentHeight: 632 }
const FIRST = '<p>one</p><p>two</p><h2>three</h2><p>four</p>'
const SECOND = '<p>second slide</p>'
const FIRST_BODIES = boardFences('board of the first slide')
const SECOND_BODIES = boardFences('board of the second slide')
const PAGINATED: SlidePlan = {
  pages: [
    { from: 0, to: 2, top: 0 },
    { from: 2, to: 4, top: 300 },
  ],
  scales: [1, 1, 1, 0.5],
}

function boardFences(body: string): FenceBodies {
  const fences = createFenceBodies()
  takeFenceIndex(fences, 'kanban', body)
  return fences
}

const deck = [FIRST, SECOND]
const FLAGS = slideSettingFlags({ math: true, mermaid: true, chart: true })
const cacheKeys = deck.map((_, index) => slideCacheKey({ fingerprint: 'fingerprint', dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))

beforeEach(() => {
  rememberSlideHtml(cacheKeys[0], { html: FIRST, fences: FIRST_BODIES })
  rememberSlideHtml(cacheKeys[1], { html: SECOND, fences: SECOND_BODIES })
})

describe('buildDeckPages', () => {
  it('gives a measured slide one printed page per page the show walks', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    expect(pages).toHaveLength(3)
    expect(pages[0]!.html).toBe('<p>one</p><p>two</p>')
    expect(pages[1]!.html).toContain('scale(0.5)')
    expect(pages[2]!.html).toBe(SECOND)
  })

  it('prints an unmeasured slide as the single page it at least has', () => {
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    expect(pages.map((page) => page.html)).toEqual([FIRST, SECOND])
  })

  it('renders a slide the show never prepared from its markdown', () => {
    const unprepared = ['```kanban\n{"title":"never prepared"}\n```']
    const pages = buildDeckPages(unprepared, ['missing:key'], {}, METRICS, FLAGS)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.html).toContain('data-kanban')
    // The printed sheet draws a board out of the body, so a page built on the spot has to carry
    // the fence body its own render read — a sliced string alone would print an empty fence.
    expect(pages[0]!.fences.kanban).toHaveLength(1)
    expect(pages[0]!.fences.kanban[0]).toContain('"never prepared"')
  })

  it('prints the prepared markup rather than the raw source when both exist', () => {
    rememberSlideHtml(cacheKeys[0], { html: '<p>enhanced</p><p>diagram</p>', fences: FIRST_BODIES })
    const pages = buildDeckPages([FIRST], [cacheKeys[0]], {}, METRICS, FLAGS)
    expect(pages[0]!.html).toBe('<p>enhanced</p><p>diagram</p>')
  })

  it('keeps the deck page order, whether or not the plan belongs to the first slide', () => {
    // Slide 1 keeps its floor page, slide 2 contributes the two its plan measured.
    const pages = buildDeckPages(deck, cacheKeys, { 1: PAGINATED }, METRICS, FLAGS)
    expect(pages).toHaveLength(3)
    expect(pages[0]!.html).toBe(FIRST)
    expect(pages[1]!.html).toBe(SECOND)
    // The plan's second page points past the end of this slide's markup, which slices to nothing
    // rather than repeating the first page.
    expect(pages[2]!.html).toBe('')
    expect(readSlideHtml(cacheKeys[1])?.html).toBe(SECOND)
  })
})

describe('buildDeckPages — the page number the room saw', () => {
  it('carries each page the position the projector showed it at', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)

    expect(pages.map((page) => page.position)).toEqual([
      { index: 0, count: 2, subPage: 0, pageCount: 2 },
      { index: 0, count: 2, subPage: 1, pageCount: 2 },
      { index: 1, count: 2, subPage: 0, pageCount: 1 },
    ])
  })

  it('counts an unmeasured slide as the one page it at least has', () => {
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)

    expect(pages.map((page) => page.position.pageCount)).toEqual([1, 1])
  })
})

describe('DeckSheet — the number printed on the page', () => {
  it('prints the same corner position the projector shows, on every exported page', async () => {
    stubFonts()
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckImageReady === 'true')
      expect(drawn).toBe(true)
      const numbers = [...document.querySelectorAll('.deck-print-page-number')].map((node) => node.textContent)
      expect(numbers).toEqual(['1 / 2 · 1/2', '1 / 2 · 2/2', '2 / 2'])
    } finally {
      view.unmount()
    }
  })

  it('hands the rasterizer the page with its number already on it', async () => {
    stubFonts()
    // This describe runs before the one that clears the rasterizer between cases, so the call this
    // reads has to be its own: the neighbour's sheet would answer '1 / 2 · 1/2' and be right about
    // its own deck.
    vi.mocked(deckImage.renderDeckPagePng).mockClear()
    // The PNG is drawn out of the same page box the printer prints, so the number the room read has
    // to be inside that box before either export reads it — a number painted beside the sheet would
    // land on the paper and not in the archive, which is the mismatch between what the room saw and what the paper carries that this closes.
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      const drawn = await until(() => vi.mocked(deckImage.renderDeckPagePng).mock.calls.length > 0)
      expect(drawn).toBe(true)
      const first = vi.mocked(deckImage.renderDeckPagePng).mock.calls[0]?.[0]
      expect(first?.querySelector('.deck-print-page-number')?.textContent).toBe('1 / 2')
    } finally {
      view.unmount()
    }
  })
})

describe('buildDeckPages — the fence bodies a page carries', () => {
  it('hands every page of a slide the bodies that slide was rendered from', () => {
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    // Slicing a page takes blocks out, never the numbering the remaining blocks point into.
    expect(pages[0]!.fences).toBe(FIRST_BODIES)
    expect(pages[1]!.fences).toBe(FIRST_BODIES)
    expect(pages[2]!.fences).toBe(SECOND_BODIES)
  })
})

describe('buildDeckPages — the layout a printed page keeps', () => {
  it('prints a column slide in the columns the projector measured it in', () => {
    const columns: SlidePlan = { pages: [{ from: 0, to: 4, top: 0 }], scales: [1, 1, 1, 1], layout: 'split' }
    const pages = buildDeckPages(deck, cacheKeys, { 0: columns }, METRICS, FLAGS)
    expect(pages[0]!.layout).toBe('split')
    expect(pages[0]!.html).toBe(FIRST)
  })

  it('prints the flow layout the projector fell back to, not the switch the slide asked for', () => {
    // The prepared markup carries `split` because that is what the author wrote; the plan carries
    // nothing because that is what the projector measured. A page that printed the columns anyway
    // would slice its pages out of a geometry the show never used.
    rememberSlideHtml(cacheKeys[0], { html: FIRST, fences: FIRST_BODIES, layout: 'split' })
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    expect(pages[0]!.layout).toBeUndefined()
    expect(pages[1]!.layout).toBeUndefined()
  })

  it('keeps the switch for a slide the show never measured', () => {
    rememberSlideHtml(cacheKeys[1], { html: SECOND, fences: SECOND_BODIES, layout: 'cover' })
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    expect(pages[1]!.layout).toBe('cover')
  })
})

describe('saveDeckPages — streaming progress', () => {
  it('reports progress incrementally for each page', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<div class="deck-print-page">1</div><div class="deck-print-page">2</div><div class="deck-print-page">3</div>'
    const progressCalls: [number, number][] = []
    const onProgress = (current: number, total: number) => {
      progressCalls.push([current, total])
    }
    const count = await saveDeckPages(root, METRICS, 'test-deck', onProgress)
    expect(count).toBe(3)
    expect(progressCalls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })
})

// A pass of the export runs through awaits (prepare, one page per round, then the archive), so the
// test gives it room and then keeps watching: how much room a pass needs is not what is being
// asserted, and a second pass inside the same window is.
async function flush(ticks: number) {
  for (let index = 0; index < ticks; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

// jsdom has no FontFaceSet, and the sheet waits for its webfonts before it hands the pages over.
// Left unshimmed the wait throws inside the component's own best-effort catch, which swallows the
// step the test is driving rather than failing it — so the marker is what bounds the wait below.
// The shim is rewritten per test because one of them hands back a font pass that never lands.
function stubFonts(ready: Promise<unknown> = Promise.resolve()) {
  Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true })
}

// Bounded, then asserted: a loop that never settles must fail as "this never happened", because a
// test that hangs instead reports a timeout and says nothing about which promise the code broke.
async function until(probe: () => boolean, budgetMs = 4000) {
  // Every pass in the sheet is chained through a frame or a dynamic import, so a fixed number of
  // turns is a bet on how fast this machine is: the same deck needed 90 turns idle and over 120
  // while the box was loaded. The probe still decides when the wait ends; a starved run just gets
  // more turns inside the same budget.
  const deadline = Date.now() + budgetMs
  while (!probe()) {
    if (Date.now() > deadline) break
    await flush(1)
  }
  return probe()
}

describe('buildDeckPages — the settings a cached page answers for', () => {
  it('prints the markdown of a page prepared under settings the account has turned off', () => {
    // The export reads the same cache the show filled. An entry the preparation chain wrote while
    // `math` was on must not print a page of formulas the room has since asked to see as source (L-16).
    rememberSlideHtml(cacheKeys[1], { html: '<p>prepared for the other settings</p>', fences: SECOND_BODIES, prepared: true, flags: '---' })
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    expect(pages[1]!.html, 'a page for other settings prints from the deck, not from that entry').not.toContain('prepared for the other settings')
    expect(pages[1]!.html).toContain('second slide')
  })
})

describe('DeckImageSheet — what the export leaves behind', () => {
  beforeEach(() => {
    stubFonts()
    vi.mocked(deckImage.saveDeckImages).mockClear()
    vi.mocked(deckImage.renderDeckPagePng).mockClear()
  })

  // The sheet is a portal on `document.body`, so each test takes its own back down in a `finally`:
  // a failed assertion that left one up would be read by the next test as its own.
  it('writes one archive for one press of the control', async () => {
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckImageReady === 'true')
      expect(drawn).toBe(true)
      await flush(10)
      expect(deckImage.saveDeckImages).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  it('hands the deck back to the show once the pictures are saved', async () => {
    // The order is the contract: a sheet that gives the deck back before the archive is written
    // takes the pages out from under the export that is still reading them.
    const steps: string[] = []
    vi.mocked(deckImage.saveDeckImages).mockImplementation(() => { steps.push('archive written') })
    const onDone = vi.fn(() => { steps.push('deck handed back') })
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone }))
    try {
      const handed = await until(() => onDone.mock.calls.length > 0)
      expect(handed).toBe(true)
      await flush(10)
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(steps).toEqual(['archive written', 'deck handed back'])
    } finally {
      view.unmount()
    }
  })

  it('hands the deck back to the overlay that is showing, not the one that mounted', async () => {
    // The sheet is handed its callbacks inline, so the render that finishes the draw has to be the
    // render they are read from: a handover taken from the mount would tell an overlay that is gone
    // that it is done while the one on screen keeps announcing itself as busy.
    let release: () => void = () => {}
    stubFonts(new Promise<void>((resolve) => { release = resolve }))
    const mounted = vi.fn()
    const showing = vi.fn()
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const sheet = (onDone: () => void) => createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone })
    const view = renderElement(sheet(mounted))
    await flush(2)
    view.rerender(sheet(showing))
    release()
    const handed = await until(() => showing.mock.calls.length > 0 || mounted.mock.calls.length > 0)
    try {
      expect(handed).toBe(true)
      await flush(10)
      expect(showing).toHaveBeenCalledTimes(1)
      expect(mounted).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  it('gives up a draw the show is no longer waiting for', async () => {
    // Leaving the show tears the sheet down while its pages are still being drawn. The pass that
    // was already in flight has to notice, or it downloads a deck nobody asked for and hands back
    // a deck the overlay has gone — and the fonts the sheet waits on are the seam that keeps it
    // in flight until the test takes the sheet away.
    let release: () => void = () => {}
    stubFonts(new Promise<void>((resolve) => { release = resolve }))
    const onDone = vi.fn()
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone }))
    await flush(2)
    view.unmount()
    release()
    await flush(20)
    expect(deckImage.renderDeckPagePng).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('DeckHandoutSheet — one page of the handout per slide', () => {
  const NOTES = ['Say the plan.', 'Ship it, then thank everyone.']

  it('gives each slide one handout page carrying its own pages and its own notes', async () => {
    stubFonts()
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    const view = renderElement(createElement(DeckHandoutSheet, { pages, notes: NOTES, metrics: METRICS, font: 'sans', dark: false, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckPrintReady === 'true')
      expect(drawn).toBe(true)
      const handouts = [...document.querySelectorAll('.deck-handout-page')]
      expect(handouts).toHaveLength(2)
      expect(handouts[0]?.querySelectorAll('.deck-handout-slide')).toHaveLength(2)
      expect(handouts[1]?.querySelectorAll('.deck-handout-slide')).toHaveLength(1)
      expect(handouts[0]?.querySelector('.deck-handout-notes')?.textContent).toBe('Say the plan.')
      expect(handouts[1]?.querySelector('.deck-handout-notes')?.textContent).toBe('Ship it, then thank everyone.')
    } finally {
      view.unmount()
    }
  })

  it('names the slide the handout page belongs to with the number the room read', async () => {
    stubFonts()
    const pages = buildDeckPages(deck, cacheKeys, { 0: PAGINATED }, METRICS, FLAGS)
    const view = renderElement(createElement(DeckHandoutSheet, { pages, notes: NOTES, metrics: METRICS, font: 'sans', dark: false, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckPrintReady === 'true')
      expect(drawn).toBe(true)
      const positions = [...document.querySelectorAll('.deck-handout-position')].map((node) => node.textContent)
      expect(positions).toEqual(['1 / 2', '2 / 2'])
    } finally {
      view.unmount()
    }
  })

  it('says a slide has no notes instead of leaving the reader a blank half-page', async () => {
    stubFonts()
    const pages = buildDeckPages(deck, cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckHandoutSheet, { pages, notes: ['', ''], metrics: METRICS, font: 'sans', dark: false, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckPrintReady === 'true')
      expect(drawn).toBe(true)
      const notes = [...document.querySelectorAll('.deck-handout-notes')].map((node) => node.textContent)
      expect(notes).toEqual([t('workspace.presentation_no_notes'), t('workspace.presentation_no_notes')])
    } finally {
      view.unmount()
    }
  })

})

describe('DeckHandoutSheet — a slide nobody measured', () => {
  it('prints a handout page for a slide the show never reached', async () => {
    // Notes are indexed by slide, so a deck whose plans stop short still gets one page per slide —
    // the handout is read by the speaker, who is not limited to the pages the idle pass measured.
    stubFonts()
    const three = [FIRST, SECOND, '<p>third</p>']
    const keys = three.map((_, index) => slideCacheKey({ fingerprint: 'fingerprint', dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))
    rememberSlideHtml(keys[2], { html: three[2], fences: FIRST_BODIES })
    const pages = buildDeckPages(three, keys, { 0: PAGINATED }, METRICS, FLAGS)
    const view = renderElement(createElement(DeckHandoutSheet, { pages, notes: ['a', 'b', 'c'], metrics: METRICS, font: 'sans', dark: false, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector<HTMLElement>('[data-deck-print]')?.dataset.deckPrintReady === 'true')
      expect(drawn).toBe(true)
      expect(document.querySelectorAll('.deck-handout-page')).toHaveLength(3)
      expect(document.querySelectorAll('.deck-handout-slide')).toHaveLength(4)
    } finally {
      view.unmount()
    }
  })
})

// The sheet is a portal on `document.body`, so the reads below go to the document, and each test
// takes its own sheet back down: a sheet a failed assertion left up would be read by the next one.
describe('DeckSheet — the deck a printed page draws', () => {
  const BOARD_BODY = JSON.stringify({
    title: 'Release plan',
    activeViewId: 'view-board',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
    ],
    views: [{ id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' }],
    items: [{ id: 'i1', title: 'Tag the build', properties: { status: 'todo' } }],
  })

  // The fixture is the renderer's own output rather than markup typed by hand: what the sheet has to
  // look past is exactly the placeholder this fork's fence emits, and a hand-written one would keep
  // passing after the real block changed shape.
  function boardMarkup(): FenceBodies {
    const rendered = renderMarkdown(['```kanban', BOARD_BODY, '```', ''].join('\n'))
    rememberSlideHtml(cacheKeys[0], { html: rendered.html, fences: rendered.fences })
    return rendered.fences
  }

  it('prints the board a slide carries instead of the promise it opened with', async () => {
    // N-38: the block arrives as "Loading kanban…", and only a host that mounts the live board ever
    // replaces that text. The sheet has no such host, so the printed page used to carry the promise.
    stubFonts()
    const fences = boardMarkup()
    expect(fences.kanban?.length, 'the fence body the board reads its cards from').toBeGreaterThan(0)
    const pages = buildDeckPages([FIRST, SECOND], cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      const drawn = await until(() => document.querySelector('[data-deck-print] .kanban-snapshot') !== null)
      expect(drawn).toBe(true)
      const sheet = document.querySelector('[data-deck-print]')!
      expect(sheet.textContent).not.toContain(t('preview.kanban_loading'))
      expect(sheet.querySelector('.kanban-snapshot')?.textContent).toContain('Tag the build')
      expect(sheet.querySelector('[data-kanban]')?.getAttribute('aria-busy')).toBe('false')
    }
    finally {
      view.unmount()
    }
  })

  // The other three passes `prepareDeckSheet` runs are each the only thing that turns one kind of
  // placeholder into a picture on the sheet, so each is asserted the same way: a dropped pass has to
  // redden a named case rather than export a page of "Rendering…" text.
  it('prints the diagram a slide carries instead of its rendering promise', async () => {
    stubFonts()
    const rendered = renderMarkdown(['```mermaid', 'flowchart LR', '  A --> B', '```', ''].join('\n'))
    rememberSlideHtml(cacheKeys[0], { html: rendered.html, fences: rendered.fences })
    const pages = buildDeckPages([FIRST, SECOND], cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      expect(await until(() => document.querySelector('[data-deck-print] [data-mermaid] svg.stub-diagram') !== null)).toBe(true)
      expect(document.querySelector('[data-deck-print]')?.textContent).not.toContain(t('markdown.rendering_diagram'))
    }
    finally {
      view.unmount()
    }
  })

  it('prints the map a slide carries instead of its rendering promise', async () => {
    stubFonts()
    const rendered = renderMarkdown(['```mindmap', '# Roadmap', '## Now', '```', ''].join('\n'))
    rememberSlideHtml(cacheKeys[0], { html: rendered.html, fences: rendered.fences })
    const pages = buildDeckPages([FIRST, SECOND], cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      expect(await until(() => document.querySelector('[data-deck-print] [data-mindmap] svg.stub-map') !== null)).toBe(true)
      expect(mindmapDraws.calls, 'the still renderer was asked for the map').toBeGreaterThan(0)
    }
    finally {
      view.unmount()
    }
  })

  it('prints the chart a slide carries on a canvas of its own', async () => {
    stubFonts()
    const rendered = renderMarkdown(['```chart', '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}', '```', ''].join('\n'))
    rememberSlideHtml(cacheKeys[0], { html: rendered.html, fences: rendered.fences })
    const pages = buildDeckPages([FIRST, SECOND], cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      expect(await until(() => document.querySelector('[data-deck-print] [data-chart] canvas') !== null)).toBe(true)
      expect(document.querySelector('[data-deck-print]')?.textContent).not.toContain(t('markdown.rendering_chart'))
    }
    finally {
      view.unmount()
    }
  })

  it('sets the formula a slide carries instead of printing its source', async () => {
    stubFonts()
    const rendered = renderMarkdown('Energy: $E=mc^2$\n')
    rememberSlideHtml(cacheKeys[0], { html: rendered.html, fences: rendered.fences })
    const pages = buildDeckPages([FIRST, SECOND], cacheKeys, {}, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    try {
      expect(await until(() => document.querySelector('[data-deck-print] .katex') !== null)).toBe(true)
    }
    finally {
      view.unmount()
    }
  })
})

describe('DeckSheet — the layout a printed page is drawn in', () => {
  it('draws the page in the layout the plan was measured with, not the switch the slide carries', async () => {
    stubFonts()
    rememberSlideHtml(cacheKeys[0], { html: FIRST, fences: FIRST_BODIES, layout: 'split' })
    const columns: SlidePlan = { pages: [{ from: 0, to: 4, top: 0 }], scales: [1, 1, 1, 1], layout: 'split' }
    const refused: SlidePlan = { pages: [{ from: 0, to: 4, top: 0 }], scales: [1, 1, 1, 1] }
    const pages = buildDeckPages(deck, cacheKeys, { 0: columns }, METRICS, FLAGS)
    const view = renderElement(createElement(DeckImageSheet, { pages, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    const drawn = await until(() => document.querySelectorAll('.deck-print-page').length === pages.length)
    try {
      expect(drawn).toBe(true)
      expect(document.querySelector('.deck-print-page [data-slide-page]')?.className).toContain('ink-slide-split')
    }
    finally {
      view.unmount()
    }
    const fell = buildDeckPages(deck, cacheKeys, { 0: refused }, METRICS, FLAGS)
    const second = renderElement(createElement(DeckImageSheet, { pages: fell, metrics: METRICS, font: 'sans', dark: false, title: 'deck', onProgress: NO_PROGRESS, onDone: vi.fn() }))
    const redrawn = await until(() => document.querySelectorAll('.deck-print-page').length === fell.length)
    try {
      expect(redrawn).toBe(true)
      expect(document.querySelector('.deck-print-page [data-slide-page]')?.className).not.toContain('ink-slide-split')
    }
    finally {
      second.unmount()
    }
  })
})
