/**
 * A book that arrives as pages rather than as prose.
 *
 * A PDF is a page description, so the reader keeps each page as the source of visual truth: PDF.js
 * paints it to a canvas and its own transparent text layer goes over the top, which is what makes the
 * words selectable, searchable and markable without rebuilding the page. A scan has no such layer, and
 * the reader says so by refusing the actions that need words rather than marking the wrong ones.
 *
 * A CBZ shares the machinery with one difference: its pages are pictures, so it always takes the
 * scan path.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../../lib/i18n'
import { readBookBlob } from '../store/library'
import { useSession } from '../../../store/session'
import type { BookRecord, Highlight } from '../types'
import type { BookPosition } from '../position'
import { DEFAULT_HIGHLIGHT_PAINT, type ReaderTheme } from '../themes'
import type { ReaderSettings } from '../store/reader-settings'
import { buildTextIndex, offsetForPoint, type TextIndex } from '../engine/text-index'
import { paintHighlights, resolveAnchor } from '../engine/highlight-anchor'
import type { PdfPageText } from '../engine/pdf'

export interface FixedStageHandle {
  next(): void
  prev(): void
  goTo(position: BookPosition): void
  current(): BookPosition | null
}

type PdfHandle = {
  document: { numPages: number; getPage(index: number): Promise<unknown>; destroy?(): Promise<unknown> }
  destroy: () => Promise<void>
}

interface FixedHit {
  /** The page number, in the same slot the shared panel calls `unit`. */
  unit: number
  offset: number
  before: string
  match: string
  after: string
}

interface FixedStageProps {
  book: BookRecord
  settings: ReaderSettings
  theme: ReaderTheme
  highlights: Highlight[]
  start: BookPosition | null
  zoom: number
  onPosition: (position: BookPosition, fraction: number) => void
  onSelection: (selection: { page: number; start: number; end: number; text: string; rect: DOMRect } | null) => void
  onMarkClick: (ids: string[], rect: DOMRect) => void
  onPage: (page: number, pages: number) => void
  /** Null for a book whose pages hold no words, which is what disables its search box. */
  onSearchReady: (search: ((query: string) => Promise<FixedHit[]>) | null) => void
}

export const FixedStage = forwardRef<FixedStageHandle, FixedStageProps>(function FixedStage({
  book, settings, theme, highlights, start, zoom, onPosition, onSelection, onMarkClick, onPage, onSearchReady,
}, ref) {
  const userId = useSession((state) => state.user?.id ?? null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(() => (start?.kind === 'fixed' ? start.page : 1))
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  /**
   * A page is sized from the stage, never from itself. Measuring the page box instead is circular — the
   * canvas starts at the browser's default 300px, so the page would keep that width however much room
   * the reader has.
   */
  const [stageWidth, setStageWidth] = useState(0)
  const [stageHeight, setStageHeight] = useState(0)
  const docRef = useRef<PdfHandle | null>(null)
  /** A CBZ's pages are pictures; they are handed out as blob URLs instead of being painted. */
  const images = useRef<string[]>([])

  useEffect(() => {
    let cancelled = false
    let opened: { destroy: () => Promise<void> } | null = null
    setReady(false)
    setError(null)
    clearFixedPageText(book.id)
    void (async () => {
      const blob = await readBookBlob(userId, book.id)
      if (!blob) {
        if (!cancelled) setError('missing')
        return
      }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (book.format === 'cbz') {
        const { openZip } = await import('../engine/zip')
        const { createResourcePool } = await import('../engine/chapter')
        const archive = await openZip(bytes)
        const members = archive.entries
          .filter((entry) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
        const pool = createResourcePool(archive, { byPath: new Map() } as never)
        const urls: string[] = []
        for (const member of members) urls.push(await pool.urlFor(member.name))
        images.current = urls
        if (!cancelled) {
          docRef.current = { destroy: async () => pool.revokeAll(), document: null as never }
          setPages(urls.length)
          setReady(true)
        }
        return
      }
      const { openPdfDocument } = await import('../engine/pdf')
      const handle = await openPdfDocument(bytes) as PdfHandle
      if (cancelled) {
        await handle.destroy()
        return
      }
      opened = handle
      docRef.current = handle
      if (!cancelled) {
        setPages(handle.document.numPages)
        setReady(true)
      }
    })().catch((err) => {
      // The reason stays in the console rather than on the page: a reader sees "this file could not be
      // read", and whoever is asked about it has the actual failure.
      console.warn('[reading] could not open the fixed-layout book', err)
      if (!cancelled) setError('corrupt')
    })
    return () => {
      cancelled = true
      void opened?.destroy()
      images.current = []
    }
  }, [book.format, book.id, userId])

  const getPage = useCallback(async (index: number) => {
    const document = docRef.current?.document
    if (!document) return null
    return document.getPage(index)
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const measure = () => {
      setStageWidth(scroller.clientWidth)
      setStageHeight(scroller.clientHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [ready])

  const spread = settings.columns === 2 && settings.readMode === 'paged' ? 2 : 1
  const firstShown = spread === 2 ? (page - 1) * 2 + 1 : page
  const shownPages = spread === 2
    ? [firstShown, firstShown + 1].filter((one) => one <= pages)
    : [page]

  const scrollPages = useMemo(() => {
    if (settings.readMode !== 'scroll' || !pages) return []
    const middle = Math.max(1, Math.min(pages, page))
    const out: number[] = []
    for (let at = Math.max(1, middle - 2); at <= Math.min(pages, middle + 3); at++) out.push(at)
    return out
  }, [page, pages, settings.readMode])

  const lastSent = useRef('')
  useEffect(() => {
    const perView = settings.readMode === 'scroll' ? 1 : spread
    const fraction = pages ? Math.min(1, (page - 1) / Math.max(1, pages / perView)) : 0
    const signature = `${page}:${pages}:${fraction.toFixed(4)}`
    if (signature === lastSent.current) return
    lastSent.current = signature
    onPage(page, pages || 1)
    onPosition({ kind: 'fixed', page }, fraction)
  }, [onPage, onPosition, page, pages, settings.readMode, spread])

  useImperativeHandle(ref, () => ({
    next: () => setPage((current) => Math.min(pages, current + spread)),
    prev: () => setPage((current) => Math.max(1, current - spread)),
    goTo: (position) => {
      if (position.kind !== 'fixed') return
      setPage(spread === 2 ? Math.floor((position.page - 1) / 2) * 2 + 1 : position.page)
    },
    current: () => ({ kind: 'fixed', page }),
  }), [page, pages, spread])

  /** In scroll mode the visible page follows the scrollbar, so a turn is a scroll. */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || settings.readMode !== 'scroll') return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const children = Array.from(scroller.querySelectorAll<HTMLElement>('[data-fixed-page]'))
        const mid = scroller.scrollTop + scroller.clientHeight / 2
        for (const child of children) {
          const top = child.offsetTop
          if (mid >= top && mid < top + child.offsetHeight) {
            setPage(Number(child.dataset.fixedPage))
            break
          }
        }
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [settings.readMode])

  const search = useCallback(async (query: string) => {
    const needle = query.trim().toLowerCase()
    if (!needle || book.format === 'cbz') return []
    const { readPdfPageText } = await import('../engine/pdf')
    const document = docRef.current?.document
    const hits: FixedHit[] = []
    for (let index = 1; index <= pages && hits.length < 300; index++) {
      let text = fixedPageTextSync(book.id, index)
      if (!text.text && document) text = await readPdfPageText(await document.getPage(index) as never)
      pageTextCache.set(cacheKey(book.id, index), text)
      const folded = text.text.toLowerCase()
      let at = folded.indexOf(needle)
      while (at >= 0 && hits.length < 300) {
        hits.push({
          unit: index,
          offset: at,
          before: text.text.slice(Math.max(0, at - 24), at),
          match: text.text.slice(at, at + needle.length),
          after: text.text.slice(at + needle.length, at + needle.length + 32),
        })
        at = folded.indexOf(needle, at + needle.length)
      }
    }
    return hits
  }, [book.format, book.id, pages])

  useEffect(() => {
    onSearchReady(book.format === 'cbz' ? null : search)
  }, [book.format, onSearchReady, search])

  const paintSelection = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      onSelection(null)
      return
    }
    const range = selection.getRangeAt(0)
    const holder = range.startContainer.parentElement
    const pageElement = holder?.closest<HTMLElement>('[data-fixed-page]')
    if (!pageElement || !pageElement.contains(range.endContainer)) {
      onSelection(null)
      return
    }
    const layer = pageElement.querySelector<HTMLElement>('.reader-pdf-text')
    const index = indexFor(layer)
    if (!index) {
      onSelection(null)
      return
    }
    const start = offsetForPoint(index, range.startContainer, range.startOffset)
    const end = offsetForPoint(index, range.endContainer, range.endOffset)
    const text = selection.toString()
    if (start < 0 || end <= start || !text.trim()) {
      onSelection(null)
      return
    }
    onSelection({
      page: Number(pageElement.dataset.fixedPage),
      start,
      end,
      text,
      rect: range.getBoundingClientRect(),
    })
  }, [onSelection])

  useLayoutEffect(() => {
    const root = scrollerRef.current
    if (!root) return
    const onUp = () => paintSelection()
    root.addEventListener('mouseup', onUp)
    root.addEventListener('touchend', onUp)
    return () => {
      root.removeEventListener('mouseup', onUp)
      root.removeEventListener('touchend', onUp)
    }
  }, [paintSelection])

  const marksFor = (index: number): Highlight[] => highlights.filter((one) => one.chapter === index - 1)

  if (error) {
    return (
      <div className="reader-stage flex items-center justify-center px-6 text-center text-[13px]" style={{ background: theme.background, color: theme.muted }}>
        {error === 'missing' ? t('reading.book_missing_hint') : t('reading.book_corrupt_hint')}
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      className="reader-stage reader-fixed"
      data-mode={settings.readMode}
      style={{ background: theme.background, '--reader-fg': theme.foreground } as React.CSSProperties}
    >
      {!ready ? <div className="reader-fixed-row"><p className="text-[12px] opacity-60">{t('reading.opening_book')}</p></div> : null}
      {ready && settings.readMode === 'scroll' ? (
        <div className="reader-fixed-stack">
          {scrollPages.map((index) => (
            <FixedPage
              key={index}
              index={index}
              bookId={book.id}
              getPage={getPage}
              image={images.current[index - 1]}
              marks={marksFor(index)}
              theme={theme}
              zoom={zoom}
              targetWidth={Math.max(320, (stageWidth || 900) - 32)}
              fit="width"
            />
          ))}
        </div>
      ) : null}
      {ready && settings.readMode === 'paged' ? (
        <div className="reader-fixed-row">
          {shownPages.map((index) => (
            <FixedPage
              key={index}
              index={index}
              bookId={book.id}
              getPage={getPage}
              image={images.current[index - 1]}
              marks={marksFor(index)}
              theme={theme}
              zoom={zoom}
              targetWidth={Math.max(240, ((stageWidth || 900) - 32 - 16) / shownPages.length)}
              targetHeight={Math.max(240, (stageHeight || 800) - 112)}
              fit="page"
              onMarkClick={onMarkClick}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
})

/**
 * One page: the painted image, PDF.js's transparent text over it, and the marks on top of that.
 *
 * The text layer is built by PDF.js so its boxes line up with the glyphs exactly; the marks are then
 * painted *inside* it by splitting its spans, which is the same routine a flowing chapter uses. That is
 * what keeps a highlight on a PDF and a highlight on an EPUB in one data model.
 */
function FixedPage({ index, bookId, getPage, image, marks, theme, zoom, targetWidth, targetHeight, fit, onMarkClick }: {
  index: number
  bookId: string
  getPage: (index: number) => Promise<unknown>
  image?: string
  marks: Highlight[]
  theme: ReaderTheme
  zoom: number
  targetWidth: number
  targetHeight?: number
  /** `page` keeps a whole sheet visible between the bars; `width` fills the column and scrolls. */
  fit?: 'page' | 'width'
  onMarkClick?: (ids: string[], rect: DOMRect) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'pending' | 'text' | 'scan'>('pending')

  useEffect(() => {
    let cancelled = false
    let painted: { task: { cancel(): void; promise: Promise<unknown> }; viewport: unknown } | null = null
    const element = holder.current
    const surface = canvas.current
    if (!element || !surface) return
    // Only the layer this effect appends is cleared: the canvas belongs to React, and removing it here
    // would leave the component painting into a node that is no longer on the page.
    for (const stale of Array.from(element.querySelectorAll('.reader-pdf-text'))) stale.remove()
    if (image) {
      surface.style.display = 'none'
      const picture = document.createElement('img')
      picture.src = image
      picture.alt = ''
      picture.className = 'reader-pdf-image'
      element.appendChild(picture)
      setState('scan')
      return () => {
        picture.remove()
      }
    }
    surface.style.display = ''
    void (async () => {
      const page = await getPage(index) as PdfPage | null
      if (!page || cancelled) return
      const { renderPdfPage, buildPdfTextLayer, readPdfTextContent } = await import('../engine/pdf')
      if (cancelled) return
      const base = page.getViewport({ scale: 1 }) as { width: number; height: number }
      const byWidth = targetWidth / Math.max(1, base.width)
      const byHeight = fit === 'page' && targetHeight ? targetHeight / Math.max(1, base.height) : byWidth
      painted = renderPdfPage(page as never, surface, Math.min(byWidth, byHeight) * zoom)
      // Turning a page cancels the render in flight and PDF.js rejects that promise. The handler goes on
      // the moment the task exists — a rejection that arrives while this function is still awaiting
      // something else would otherwise be reported as an unhandled error — and the outcome is inspected
      // below, where the cancellation is known.
      const render = painted.task.promise
      render.catch(() => {})
      const content = await page.getTextContent()
      if (cancelled) return
      try {
        await render
      } catch (err) {
        console.warn('[reading] the page could not be painted', err)
        setState('scan')
        return
      }
      pageTextCache.set(cacheKey(bookId, index), readPdfTextContent(content as never))
      const layer = document.createElement('div')
      layer.className = 'reader-pdf-text'
      // PDF.js sizes its own layer with `round(down, var(--total-scale-factor) * 612px,
      // var(--scale-round-x))`, and the viewer is expected to supply all three. Left unset the
      // expression is invalid, the layer falls back to `auto`, and the page's white box grows wider
      // than the picture under it.
      layer.style.setProperty('--total-scale-factor', String((painted.viewport as { scale: number }).scale))
      layer.style.setProperty('--scale-round-x', '1px')
      layer.style.setProperty('--scale-round-y', '1px')
      element.appendChild(layer)
      const built = buildPdfTextLayer(layer, content as never, painted.viewport as never)
      // The constructor only stores its arguments; render() is what writes the spans.
      await built.render()
      setState((content as { items: unknown[] }).items.length ? 'text' : 'scan')
    })().catch(() => {
      if (!cancelled) setState('scan')
    })
    return () => {
      cancelled = true
      painted?.task.cancel()
    }
  }, [bookId, fit, getPage, image, index, targetHeight, targetWidth, zoom])

  /** The marks go on after the layer exists, because the layer is what their offsets index into. */
  useEffect(() => {
    const layer = holder.current?.querySelector<HTMLElement>('.reader-pdf-text')
    if (!layer || !marks.length) return
    const index2 = indexFor(layer)
    if (!index2) return
    const resolved = new Map<string, ReturnType<typeof resolveAnchor>>()
    const usable: Highlight[] = []
    for (const mark of marks) {
      const anchor = resolveAnchor(index2, mark)
      resolved.set(mark.id, anchor)
      if (anchor.state !== 'orphan') usable.push(mark)
    }
    paintHighlights(index2, usable, resolved, (one) => DEFAULT_HIGHLIGHT_PAINT[one.color] ?? DEFAULT_HIGHLIGHT_PAINT.yellow!)
  }, [index, marks, state])

  return (
    <div
      ref={holder}
      data-fixed-page={index}
      className="reader-pdf-page"
      data-textable={state === 'text' ? 'true' : 'false'}
      title={state === 'scan' ? t('reading.page_has_no_text') : undefined}
      onClick={(event) => {
        const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('.reader-mark')
        if (!mark || !onMarkClick) return
        const ids = (mark.dataset.hl ?? '').split(' ').filter(Boolean)
        if (ids.length) {
          event.preventDefault()
          onMarkClick(ids, mark.getBoundingClientRect())
        }
      }}
      style={{ '--reader-mark-default': theme.accent } as React.CSSProperties}
    >
      <canvas ref={canvas} />
    </div>
  )
}

const pageTextCache = new Map<string, PdfPageText>()

function cacheKey(bookId: string, index: number): string {
  return `${bookId}|${index}`
}

/**
 * The text index of a rendered text layer.
 *
 * PDF.js writes one span per text run in the order `getTextContent` reported them, so the layer's own
 * concatenated text is the coordinate space a stored highlight uses. Rebuilding it from the DOM rather
 * than trusting the content object is what keeps search and marking in step after an earlier mark has
 * split the spans.
 */
function indexFor(layer: HTMLElement | null): TextIndex | null {
  if (!layer) return null
  const cached = LAYER_INDEXES.get(layer)
  if (cached && cached.nodes.every((node) => node.isConnected)) return cached
  const built = buildTextIndex(layer)
  LAYER_INDEXES.set(layer, built)
  return built
}

const LAYER_INDEXES = new WeakMap<HTMLElement, TextIndex>()

/** The slice of a PDF page this component uses, kept structural so the engine stays lazily loaded. */
type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number }
  getTextContent(): Promise<{ items: unknown[] }>
  render(parameters: unknown): { task: { cancel(): void }; promise: Promise<unknown> }
}

/** A page's cached text, or an empty one when the page has not been read yet. */
function fixedPageTextSync(bookId: string, index: number): PdfPageText {
  return pageTextCache.get(cacheKey(bookId, index)) ?? { text: '', items: [] }
}

export function clearFixedPageText(bookId: string): void {
  for (const key of pageTextCache.keys()) {
    if (key.startsWith(`${bookId}|`)) pageTextCache.delete(key)
  }
}


