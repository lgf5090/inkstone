// @vitest-environment jsdom
import { createRef, act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EpubStage, type EpubStageHandle } from '../src/client/features/reading/reader/EpubStage'
import type { EpubHandle } from '../src/client/features/reading/reader/useEpubHandle'
import type { PreparedChapter } from '../src/client/features/reading/engine/chapter'
import { buildTextIndex } from '../src/client/features/reading/engine/text-index'
import { computeGeometry, scrollForPage } from '../src/client/features/reading/engine/paginate'
import { DEFAULT_READER_SETTINGS, type ReaderSettings } from '../src/client/features/reading/store/reader-settings'
import { READER_THEMES } from '../src/client/features/reading/themes'
import { renderElement, installTestGlobals, type RenderedElement } from '../src/client/lib/test-render'

const geometry = computeGeometry(800, 1, 16)
const paragraphLength = 10
const paragraphCount = 30
const paragraphs = Array.from({ length: paragraphCount }, (_, index) => (
  `<p id="p${index}" data-start="${index * paragraphLength}">${String(index).padStart(2, '0')}:${'x'.repeat(7)}</p>`
))
const chapterHtml = paragraphs.join('')

function prepared(html = chapterHtml): PreparedChapter {
  return { html, css: '', heading: 'Chapter', textLength: html.replace(/<[^>]+>/g, '').length }
}

function mockHandle(prepare: EpubHandle['prepare']): EpubHandle {
  const item = { id: 'c1', href: 'chapter1.xhtml', mediaType: 'application/xhtml+xml', properties: [] }
  return {
    kind: 'epub',
    pkg: {
      metadata: { title: 'Test', creator: '', language: 'en', identifier: '', publisher: '', modified: '' },
      manifest: new Map([[item.id, item]]),
      byPath: new Map([[item.href, item]]),
      spine: [0, 1].map((index) => ({
        idref: `c${index + 1}`,
        item: { ...item, id: `c${index + 1}`, href: `chapter${index + 1}.xhtml` },
        linear: true,
      })),
      toc: [],
      direction: 'ltr',
      coverHref: null,
    },
    prepare,
  } as unknown as EpubHandle
}

function charsPerPage(stage: HTMLElement | null): number {
  const fontSize = Number.parseFloat(stage?.style.getPropertyValue('--reader-size') ?? '19')
  return fontSize >= 30 ? 20 : 40
}

class ObserverStub {
  static instances: ObserverStub[] = []
  private readonly callback: ResizeObserverCallback
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ObserverStub.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

let view: RenderedElement | null = null

beforeEach(() => {
  ObserverStub.instances = []
  vi.stubGlobal('ResizeObserver', ObserverStub)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('reader-stage') ? 800 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('reader-columns')) return 0
    const doc = this.querySelector<HTMLElement>('.reader-doc')
    const stage = this.closest<HTMLElement>('.reader-stage')
    const pages = Math.max(1, Math.ceil((doc?.textContent?.length ?? 0) / charsPerPage(stage)))
    return geometry.viewport + (pages - 1) * geometry.step
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    const start = Number(this.dataset.start)
    if (!Number.isFinite(start)) return 0
    const stage = this.closest<HTMLElement>('.reader-stage')
    return Math.floor(start / charsPerPage(stage)) * geometry.step
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    const start = Number(this.dataset.start)
    if (!Number.isFinite(start)) return 0
    const stage = this.closest<HTMLElement>('.reader-stage')
    return start * (charsPerPage(stage) === 20 ? 2 : 1)
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

interface StageOptions {
  start?: { kind: 'epub'; chapter: number; offset: number } | null
  settings?: ReaderSettings
  prepare?: EpubHandle['prepare']
}

async function mountStage(options: StageOptions = {}) {
  const handleRef = createRef<EpubStageHandle>()
  const onPosition = vi.fn()
  const onPageChange = vi.fn()
  const onChapter = vi.fn()
  const handle = mockHandle(options.prepare ?? (async (slot) => prepared(slot === 1 ? chapterHtml.replace(/:/g, ';') : chapterHtml)))
  const settings = options.settings ?? { ...DEFAULT_READER_SETTINGS, fontSize: 19 }
  const start = options.start === undefined ? { kind: 'epub' as const, chapter: 0, offset: 80 } : options.start
  const paging = { zones: 'off' as const, swipe: false, onCenterTap: () => {} }
  const render = (nextSettings: ReaderSettings) => createElement(EpubStage, {
    ref: handleRef,
    handle,
    settings: nextSettings,
    theme: READER_THEMES.paper,
    highlights: [],
    start,
    onPosition,
    onSelection: () => {},
    onMarkClick: () => {},
    onFootnote: () => {},
    onChapter,
    onPageChange,
    paging,
  })
  view = renderElement(render(settings))
  await act(async () => { await Promise.resolve() })
  return {
    handleRef,
    handle,
    onPosition,
    onPageChange,
    onChapter,
    rerender: (next: ReaderSettings) => view!.rerender(render(next)),
    stage: () => view!.container.querySelector<HTMLElement>('.reader-stage')!,
    columns: () => view!.container.querySelector<HTMLElement>('.reader-columns')!,
    doc: () => view!.container.querySelector<HTMLElement>('.reader-doc')!,
  }
}

describe('EpubStage relayout anchors', () => {
  it('restores the last reported offset when a font-size change repaginates the chapter', async () => {
    const mounted = await mountStage()
    const expectedInitialPage = Math.floor(80 / 40)
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 80 })
    expect(mounted.onPageChange).toHaveBeenLastCalledWith(expectedInitialPage + 1, 8)
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(expectedInitialPage, geometry))

    mounted.rerender({ ...DEFAULT_READER_SETTINGS, fontSize: 34 })

    // The same words move from page 3 to page 5. Keeping the old page/scroll would show paragraphs 4–5.
    const expectedTargetPage = Math.floor(80 / 20)
    const target = mounted.doc().querySelector<HTMLElement>('[data-start="80"]')!
    const index = buildTextIndex(mounted.doc())
    expect(index.text.slice(80, 90)).toBe(target.textContent)
    expect(target.offsetLeft).toBe(scrollForPage(expectedTargetPage, geometry))
    expect(mounted.columns().scrollLeft).toBe(target.offsetLeft)
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 80 })
    expect(mounted.onPosition).toHaveBeenLastCalledWith({ kind: 'epub', chapter: 0, offset: 80 }, expect.any(Number))
    expect(mounted.onPageChange).toHaveBeenLastCalledWith(expectedTargetPage + 1, 15)

    const reports = mounted.onPosition.mock.calls.length
    const observer = ObserverStub.instances.at(-1)!
    await act(async () => {
      observer.trigger()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(mounted.onPosition).toHaveBeenCalledTimes(reports)
    expect(mounted.columns().scrollLeft).toBe(target.offsetLeft)

    mounted.rerender({ ...DEFAULT_READER_SETTINGS, fontSize: 19 })
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(2, geometry))
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 80 })
  })

  it('restores the reported vertical position in scroll mode', async () => {
    installTestGlobals()
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const stage = this.closest<HTMLElement>('.reader-stage')!
      const start = Number((this as HTMLElement).dataset.start)
      if (Number.isFinite(start)) stage.scrollTop = start * (charsPerPage(stage) === 20 ? 2 : 1)
    })
    const mounted = await mountStage({ settings: { ...DEFAULT_READER_SETTINGS, readMode: 'scroll' } })
    const stage = mounted.stage()
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 80 })
    expect(stage.scrollTop).toBe(80)

    mounted.rerender({ ...DEFAULT_READER_SETTINGS, readMode: 'scroll', fontSize: 34 })

    expect(stage.scrollTop).toBe(160)
    expect(scrollIntoView).toHaveBeenCalled()
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 80 })
    expect(mounted.onPosition).toHaveBeenLastCalledWith({ kind: 'epub', chapter: 0, offset: 80 }, expect.any(Number))
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('keeps an explicit new-chapter anchor ahead of a font change while it loads', async () => {
    let resolveNext!: (chapter: PreparedChapter | null) => void
    const nextChapter = new Promise<PreparedChapter | null>((resolve) => { resolveNext = resolve })
    const mounted = await mountStage({
      prepare: async (slot) => slot === 1 ? nextChapter : prepared(),
    })

    await act(async () => {
      mounted.handleRef.current!.goTo({ kind: 'epub', chapter: 1, offset: 120 })
    })
    mounted.rerender({ ...DEFAULT_READER_SETTINGS, fontSize: 34 })
    await act(async () => {
      resolveNext(prepared(chapterHtml.replace(/:/g, ';')))
      await Promise.resolve()
    })

    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 1, offset: 120 })
    expect(mounted.onPosition).toHaveBeenLastCalledWith({ kind: 'epub', chapter: 1, offset: 120 }, expect.any(Number))
    expect(mounted.onPageChange).toHaveBeenLastCalledWith(7, 15)
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(6, geometry))
  })

  it('honours an initial start offset', async () => {
    const mounted = await mountStage({ start: { kind: 'epub', chapter: 0, offset: 160 } })
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 160 })
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(4, geometry))
  })

  it('honours an end anchor when turning into the previous chapter', async () => {
    const mounted = await mountStage({ start: { kind: 'epub', chapter: 1, offset: 0 } })
    await act(async () => { mounted.handleRef.current!.prev() })
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 280 })
    expect(mounted.onPageChange).toHaveBeenLastCalledWith(8, 8)
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(7, geometry))
  })

  it('honours fraction and fragment anchors', async () => {
    const mounted = await mountStage()
    await act(async () => { mounted.handleRef.current!.goToFraction(0.25) })
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(4, geometry))
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 160 })

    await act(async () => {
      mounted.handleRef.current!.goTo({ kind: 'epub', chapter: 0, offset: 0 }, 'p20')
    })
    expect(mounted.columns().scrollLeft).toBe(scrollForPage(5, geometry))
    expect(mounted.handleRef.current?.current()).toEqual({ kind: 'epub', chapter: 0, offset: 200 })

    await act(async () => {
      mounted.handleRef.current!.goTo({ kind: 'epub', chapter: 0, offset: 0 }, 'missing')
    })
    expect(mounted.columns().scrollLeft).toBe(0)
  })
})
