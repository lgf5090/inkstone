/**
 * Which export a press asks for, and what the show therefore holds.
 *
 * Both exports read the same pages, so the kind has to be part of what is held: holding the pages alone
 * would mount the printed deck and the handout at the same time and print two sheets for one press.
 * The handout adds the second half of that contract — a sheet the speaker reads has to carry the
 * notes, and the notes are indexed by slide, not by printed page (N-32).
 */
import { act, createElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { createFenceBodies } from '../../lib/markdown/fence-bodies'
import { useDeckExport, type DeckExportOptions } from './deck-export'
import { clearSlideHtmlCache, rememberSlideHtml, slideCacheKey, slideSettingFlags } from './slide-html'
import type { StageMetrics } from './slide-stage'

vi.mock('./deck-image', () => ({
  deckImageGeometry: vi.fn(() => ({ width: 1280, height: 720, padX: 0, padY: 0 })),
  collectDeckCss: vi.fn(async () => ''),
  renderDeckPagePng: vi.fn(async () => new Blob(['fake-png'], { type: 'image/png' })),
  zipDeckImages: vi.fn(async () => new Blob(['fake-zip'], { type: 'application/zip' })),
  saveDeckImages: vi.fn(),
}))
// The builder is real — what the third export owes its assertions to is the document it asks for — and
// only the save is stood in for, because writing to disk is not what this hook decides.
const saveDeckHtml = vi.hoisted(() => vi.fn())
vi.mock('./deck-html', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deck-html')>()
  return { ...actual, saveDeckHtml }
})
// One spy for the whole module: a `getState()` that handed back a fresh `vi.fn()` each call would
// record the press somewhere the assertions never look.
const toast = vi.hoisted(() => vi.fn())
vi.mock('../../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }))

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  toast.mockClear()
})

const METRICS: StageMetrics = { scale: 1, designWidth: 1280, designHeight: 720, contentWidth: 1168, contentHeight: 632 }
const DECK = ['One page of talk.', 'Another page of talk.']
const NOTES = ['Say the plan.', 'Then thank everyone.']
const KEYS = DECK.map((text, index) => slideCacheKey({ fingerprint: text, dark: false, index, contentWidth: METRICS.contentWidth, contentHeight: METRICS.contentHeight }))

function options(overrides: Partial<DeckExportOptions> = {}): DeckExportOptions {
  return {
    deck: DECK,
    cacheKeys: KEYS,
    plans: {},
    metrics: METRICS,
    flags: slideSettingFlags({ math: true, mermaid: true, chart: true }),
    dark: false,
    title: 'Release plan',
    notes: NOTES,
    proseFont: 'sans',
    ...overrides,
  }
}

function mountExports(overrides: Partial<DeckExportOptions> = {}) {
  let held: ReturnType<typeof useDeckExport> | null = null
  function Probe() {
    held = useDeckExport(options(overrides))
    return null
  }
  const view = renderElement(createElement(Probe))
  return {
    get exports() {
      if (!held) throw new Error('the export hook never mounted')
      return held
    },
    unmount: () => view.unmount(),
  }
}

/**
 * The pass that measures the deck runs on idle time, and a presenter who exports the moment the show
 * opens asks for pages of slides nobody has measured yet. Those print as the one page they are known
 * to have, which is fewer than the show will walk — a mismatch the speaker has to be told about
 * rather than discover in the handout (N-38).
 */
// Read by both describes below: the plans a deck has when the pass is halfway, and what the export
// said out loud.
const measured = [
  { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] },
  { pages: [{ from: 0, to: 1, top: 0 }], scales: [1] },
]

function toasts() {
  return toast.mock.calls.map(([call]) => call?.title ?? '')
}

describe('useDeckExport — an export taken mid-measurement says so', () => {
  it('names how many slides are still unmeasured when one press asks for the deck', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports({ plans: { 0: measured[0] } as never })
    try {
      act(() => {
        show.exports.exportDeck()
      })
      expect(toasts()).toEqual([t('workspace.presentation_export_unmeasured', { value0: 1 })])
    } finally {
      show.unmount()
    }
  })

})

describe('useDeckExport — the notice keeps its bounds', () => {
  it('stays quiet once every slide of the deck has a plan', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports({ plans: { 0: measured[0], 1: measured[1] } as never })
    try {
      act(() => {
        show.exports.exportHandout()
      })
      expect(toasts()).toEqual([])
    } finally {
      show.unmount()
    }
  })

  it('says it once per press, whichever export was asked for', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports({ plans: {} })
    try {
      act(() => {
        show.exports.exportImages()
      })
      expect(toasts().length).toBe(1)
    } finally {
      show.unmount()
    }
  })
})

describe('useDeckExport — one press holds one sheet', () => {
  it('holds the handout with the notes the speaker wrote, and no other sheet', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports()
    try {
      act(() => { show.exports.exportHandout() })
      expect(show.exports.handout?.notes).toEqual(NOTES)
      expect(show.exports.handout?.pages).toHaveLength(2)
      expect(show.exports.print).toBeNull()
      expect(show.exports.images).toBeNull()
    } finally {
      show.unmount()
    }
  })

  it('keeps the printed deck and the handout from being mounted for one another', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports()
    try {
      act(() => { show.exports.exportDeck() })
      expect(show.exports.print?.pages).toHaveLength(2)
      expect(show.exports.handout).toBeNull()
      act(() => { show.exports.print?.done() })
      act(() => { show.exports.exportHandout() })
      expect(show.exports.handout?.pages).toHaveLength(2)
      expect(show.exports.print).toBeNull()
    } finally {
      show.unmount()
    }
  })

  it('hands the handout back to the show once it is printed', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports()
    try {
      act(() => { show.exports.exportHandout() })
      act(() => { show.exports.handout?.done() })
      expect(show.exports.handout).toBeNull()
    } finally {
      show.unmount()
    }
  })
})

// Every slide measured by default: the notice about a deck still being listed is the third export's
// shared behaviour, and the case that asks for it brings its own plans.
function mountSteppedFile(plans: Record<number, unknown> = { 0: measured[0], 1: measured[1] }) {
  clearSlideHtmlCache()
  DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
  saveDeckHtml.mockClear()
  saveDeckHtml.mockImplementation(() => undefined)
  return mountExports({ plans: plans as never })
}

describe('useDeckExport — the deck as a file someone else can play', () => {
  it('hands over a complete document, named after the note it came from', async () => {
    const show = mountSteppedFile()
    // The theme this document is wearing is part of what the file has to carry, so the case wears one.
    document.documentElement.dataset.theme = 'dark'
    try {
      await act(async () => { show.exports.exportHtml() })
      expect(saveDeckHtml).toHaveBeenCalledTimes(1)
      const [html, title] = saveDeckHtml.mock.calls[0] as [string, string]
      expect(title).toBe('Release plan')
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('<p>0</p>')
      expect(html).toContain('data-theme="dark"')
      expect(html).toContain('<p>1</p>')
    } finally {
      delete document.documentElement.dataset.theme
      show.unmount()
    }
  })

  it('says the file is saved, in the words the show already uses for a saved export', async () => {
    const show = mountSteppedFile()
    try {
      await act(async () => { show.exports.exportHtml() })
      expect(toasts()).toEqual([t('workspace.presentation_html_saved')])
      expect(show.exports.htmlBusy, 'the export is over, so the control stops saying so').toBe(false)
    } finally {
      show.unmount()
    }
  })
})

describe('useDeckExport — what the standalone file says when it cannot be written', () => {
  it('says out loud when nothing could be written', async () => {
    const show = mountSteppedFile()
    saveDeckHtml.mockImplementationOnce(() => { throw new Error('disk said no') })
    try {
      await act(async () => { show.exports.exportHtml() })
      expect(toasts()).toEqual([t('workspace.presentation_html_failed')])
      expect(show.exports.htmlBusy).toBe(false)
    } finally {
      show.unmount()
    }
  })

  it('starts no second file while one is still being written', async () => {
    const show = mountSteppedFile()
    // The window a second press has to be refused in is the styles being collected: two presses in a
    // row, then everything settles, and the deck was written once.
    try {
      act(() => { show.exports.exportHtml() })
      act(() => { show.exports.exportHtml() })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(saveDeckHtml).toHaveBeenCalledTimes(1)
      expect(show.exports.htmlBusy).toBe(false)
    } finally {
      show.unmount()
    }
  })

})

describe('useDeckExport — the standalone file keeps the show company', () => {
  it('presses the third export only once per press, whatever else is held', () => {
    clearSlideHtmlCache()
    DECK.forEach((_, index) => rememberSlideHtml(KEYS[index], { html: `<p>${index}</p>`, fences: createFenceBodies() }))
    const show = mountExports()
    try {
      act(() => { show.exports.exportDeck() })
      act(() => { show.exports.exportHtml() })
      expect(show.exports.print?.pages).toHaveLength(2)
      expect(show.exports.htmlBusy, 'the file is being written, and the control says so').toBe(true)
    } finally {
      show.unmount()
    }
  })

  it('notices a slide nobody measured yet, the same way the other two exports do', async () => {
    const show = mountSteppedFile({})
    try {
      await act(async () => { show.exports.exportHtml() })
      expect(toasts()).toEqual([t('workspace.presentation_export_unmeasured', { value0: 2 }), t('workspace.presentation_html_saved')])
    } finally {
      show.unmount()
    }
  })
})
