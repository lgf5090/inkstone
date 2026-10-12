/**
 * The page a reader actually looks at.
 *
 * One chapter is laid out at a time inside a column box, and a page turn moves the box sideways. That
 * is the whole trick, and it has three consequences this component exists to manage: the page count is
 * only known *after* layout (so images arriving late change it), a position must survive a resize
 * (so the reader's place is stored as text, not as a scroll offset), and turning past either end of a
 * chapter has to load its neighbour and land on the right page of it.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { EpubHandle } from './useEpubHandle'
import type { PreparedChapter } from '../engine/chapter'
import { buildTextIndex, offsetForPoint, pointForOffset, type TextIndex } from '../engine/text-index'
import { paintHighlights, resolveAnchor } from '../engine/highlight-anchor'
import {
  chapterProgress,
  computeGeometry,
  pageCount,
  pageForOffset,
  scrollForPage,
  type PageGeometry,
} from '../engine/paginate'
import { spineIndexFor, stripFragment } from '../engine/epub-package'
import type { BookPosition } from '../position'
import type { Highlight } from '../types'
import { t } from '../../../lib/i18n'
import type { ReaderSettings } from '../store/reader-settings'
import { fontStackFor } from '../store/reader-settings'
import { DEFAULT_HIGHLIGHT_PAINT, type ReaderTheme } from '../themes'

export interface StageSelection {
  start: number
  end: number
  text: string
  rect: DOMRect
  /** Which chapter or page the selection was made on; the stage's own slot when it is absent. */
  chapter?: number
}

export interface EpubStageHandle {
  next(): void
  prev(): void
  goTo(position: BookPosition, fragment?: string): void
  current(): BookPosition | null
  chapterIndex(): number
  /** Re-run the layout pass, which is what a settings change or a font arriving needs. */
  relayout(): void
}

interface EpubStageProps {
  handle: EpubHandle
  settings: ReaderSettings
  theme: ReaderTheme
  highlights: Highlight[]
  start: BookPosition | null
  onPosition: (position: BookPosition, fraction: number) => void
  onSelection: (selection: StageSelection | null) => void
  onMarkClick: (ids: string[], rect: DOMRect) => void
  onChapter: (index: number) => void
  onPageChange: (page: number, pages: number) => void
}

export const EpubStage = forwardRef<EpubStageHandle, EpubStageProps>(function EpubStage({
  handle,
  settings,
  theme,
  highlights,
  start,
  onPosition,
  onSelection,
  onMarkClick,
  onChapter,
  onPageChange,
}, ref) {
  const stageRef = useRef<HTMLDivElement>(null)
  const columnsRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLStyleElement>(null)
  const [slot, setSlot] = useState(() => (start?.kind === 'epub' ? start.chapter : 0))
  const [chapter, setChapter] = useState<PreparedChapter | null>(null)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(1)
  const [failed, setFailed] = useState(false)
  const geometryRef = useRef<PageGeometry>(computeGeometry(800, 1, 24))
  /** Where to land once the next chapter has laid out: an offset, or the end of the chapter. */
  const anchorRef = useRef<{ kind: 'offset'; offset: number } | { kind: 'end' } | { kind: 'fragment'; id: string } | null>(
    start?.kind === 'epub' ? { kind: 'offset', offset: start.offset } : null,
  )
  const indexRef = useRef<TextIndex | null>(null)
  const [layoutNonce, setLayoutNonce] = useState(0)
  /**
   * The owner's callbacks live in a ref because a parent re-render hands over new function identities
   * every time. Read directly from the props inside an effect, they re-trigger the effects that depend
   * on them, which re-enter the parent's state, which re-renders — and the reader sees React's
   * "maximum update depth exceeded" instead of a page.
   */
  const emit = useRef({ onPosition, onPageChange, onSelection, onMarkClick, onChapter })
  useEffect(() => {
    emit.current = { onPosition, onPageChange, onSelection, onMarkClick, onChapter }
  })
  const lastSent = useRef('')

  /**
   * Loading is a function of the slot, never of the call that changed it.
   *
   * A page turn, a contents jump and a restored position all end up setting `slot`, so putting the read
   * here means there is one place that can be in a half-loaded state — and `missing` is a real outcome
   * rather than a spinner that never stops.
   */
  useEffect(() => {
    let cancelled = false
    setChapter(null)
    setFailed(false)
    void handle.prepare(slot).then((prepared) => {
      if (cancelled) return
      if (!prepared) {
        setFailed(true)
        return
      }
      setChapter(prepared)
      emit.current.onChapter(slot)
    }, () => {
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [handle, slot])

  /** Put the chapter's markup and its (already confined) stylesheet on the page. */
  useLayoutEffect(() => {
    const doc = docRef.current
    const style = styleRef.current
    if (!doc || !style) return
    doc.innerHTML = chapter?.html ?? ''
    style.textContent = chapter?.css ?? ''
    indexRef.current = null
    setLayoutNonce((nonce) => nonce + 1)
  }, [chapter])

  const geometry = useCallback((): PageGeometry => {
    const stage = stageRef.current
    const columns = settings.columns
    const width = stage?.clientWidth ?? 800
    // A single column has no gutter to cross, so the step is exactly the viewport; two columns share
    // the reader's margin as the fold between them.
    const gap = columns > 1 ? Math.max(16, settings.margin) : 0
    return computeGeometry(width, columns, gap)
  }, [settings.columns, settings.margin])

  const measure = useCallback((): number => {
    const columns = columnsRef.current
    if (!columns) return 1
    return pageCount(columns.scrollWidth, geometryRef.current)
  }, [])

  /**
   * Lay the chapter out and decide where the reader is.
   *
   * Runs on every change that can move text — a new chapter, a settings change, a resize, an image
   * finishing its decode — and always restores the *same words*, which is why the anchor is a text
   * offset rather than a page number.
   */
  const relayout = useCallback(() => {
    const columns = columnsRef.current
    const doc = docRef.current
    const stage = stageRef.current
    if (!columns || !doc || !stage) return
    const next = geometry()
    geometryRef.current = next
    const scrollMode = settings.readMode === 'scroll'
    stage.style.setProperty('--reader-column-width', `${next.columnWidth}px`)
    stage.style.setProperty('--reader-gap', `${next.gap}px`)

    if (!indexRef.current) indexRef.current = buildTextIndex(doc)
    const count = scrollMode ? 1 : measure()
    setPages(count)

    const anchor = anchorRef.current
    if (!anchor) return
    anchorRef.current = null
    if (scrollMode || count <= 1) {
      if (anchor.kind === 'offset') {
        const point = pointForOffset(indexRef.current!, anchor.offset)
        point?.node.parentElement?.scrollIntoView({ block: 'start' })
      } else if (anchor.kind === 'fragment') {
        doc.querySelector(`[id="${cssEscape(anchor.id)}"]`)?.scrollIntoView({ block: 'start' })
      }
      setPage(0)
      return
    }
    let target = 0
    if (anchor.kind === 'end') {
      target = count - 1
    } else if (anchor.kind === 'fragment') {
      const element = doc.querySelector<HTMLElement>(`[id="${cssEscape(anchor.id)}"]`)
      target = element ? pageForOffset(element.offsetLeft, next) : 0
    } else {
      const point = pointForOffset(indexRef.current!, anchor.offset)
      const element = point?.node.parentElement
      target = element ? pageForOffset(element.offsetLeft, next) : 0
    }
    setPage(Math.min(count - 1, Math.max(0, target)))
  }, [geometry, measure, settings.readMode])

  useLayoutEffect(() => {
    relayout()
  }, [chapter, layoutNonce, relayout, settings.fontSize, settings.lineHeight, settings.letterSpacing,
    settings.paragraphSpacing, settings.margin, settings.columns, settings.textAlign, settings.fontFamily,
    settings.customFamily, settings.readMode, settings.firstLineIndent, settings.hyphenate, settings.showFigures])

  /** A late image or a webfont that arrives after the first pass changes the page count. */
  useEffect(() => {
    const doc = docRef.current
    const stage = stageRef.current
    if (!doc || !stage) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        relayout()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(doc)
    for (const image of Array.from(doc.querySelectorAll('img'))) {
      if (!image.complete) {
        image.addEventListener('load', schedule, { once: true })
        image.addEventListener('error', schedule, { once: true })
      }
    }
    const resize = () => schedule()
    window.addEventListener('resize', resize)
    document.fonts?.addEventListener?.('loadingdone', resize)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      document.fonts?.removeEventListener?.('loadingdone', resize)
    }
  }, [chapter, relayout])

  /** Paint the marks. The index is rebuilt afterwards so a selection made over a mark still lands. */
  useEffect(() => {
    const doc = docRef.current
    if (!doc || !chapter) return
    const index = buildTextIndex(doc)
    indexRef.current = index
    const resolved = new Map<string, ReturnType<typeof resolveAnchor>>()
    const mine: Highlight[] = []
    for (const highlight of highlights) {
      const anchor = resolveAnchor(index, highlight)
      resolved.set(highlight.id, anchor)
      if (anchor.state !== 'orphan') mine.push(highlight)
    }
    paintHighlights(index, mine, resolved, (one) => DEFAULT_HIGHLIGHT_PAINT[one.color] ?? DEFAULT_HIGHLIGHT_PAINT.yellow!)
    indexRef.current = buildTextIndex(doc)
    setLayoutNonce((nonce) => nonce + 1)
  }, [chapter, highlights])

  /** Drive the scroll position from the page number, which is the only thing the UI owns. */
  useLayoutEffect(() => {
    const columns = columnsRef.current
    if (!columns || settings.readMode === 'scroll') return
    columns.scrollLeft = scrollForPage(page, geometryRef.current)
  }, [page, settings.readMode, chapter, layoutNonce])

  /**
   * Where the reader is, as a chapter and a character offset.
   *
   * The offset is the first character that has moved past the left edge of the viewport, which is what
   * a reader means by "the page I am looking at" — and it is why closing the book and reopening it lands
   * on the same sentence rather than on a page number that a font change has since invalidated.
   */
  const currentOffset = useCallback((): number => {
    const index = indexRef.current
    const doc = docRef.current
    const stage = stageRef.current
    if (!index || !doc) return 0
    const scrollMode = settings.readMode === 'scroll'
    // In scroll mode the reader's place is a vertical position rather than a column offset.
    const limit = scrollMode && stage ? stage.scrollTop : scrollForPage(page, geometryRef.current)
    let best = 0
    for (let at = 0; at < index.nodes.length; at++) {
      const element = index.nodes[at]!.parentElement
      if (!element) continue
      const position = scrollMode && stage ? element.offsetTop - doc.offsetTop : element.offsetLeft
      if (position > limit) break
      best = index.starts[at]! + (index.nodes[at]!.nodeValue?.length ?? 0)
    }
    return Math.min(best, index.text.length)
  }, [page, settings.readMode])

  const report = useCallback(() => {
    const index = indexRef.current
    const stage = stageRef.current
    if (!index) return
    const offset = currentOffset()
    const scrollMode = settings.readMode === 'scroll'
    // A column page is the whole chapter, so in scroll mode the bar tracks the scrolled height: a
    // reader three quarters down is three quarters through.
    const fraction = scrollMode && stage && stage.scrollHeight > stage.clientHeight
      ? Math.min(1, (stage.scrollTop + stage.clientHeight) / stage.scrollHeight)
      : chapterProgress(page, pages).fraction
    const progress = scrollMode ? { page: 1, pages: 1 } : chapterProgress(page, pages)
    const signature = `${slot}:${offset}:${progress.page}:${progress.pages}:${fraction.toFixed(3)}`
    if (signature === lastSent.current) return
    lastSent.current = signature
    emit.current.onPageChange(progress.page, progress.pages)
    emit.current.onPosition({ kind: 'epub', chapter: slot, offset }, fraction)
  }, [currentOffset, page, pages, settings.readMode, slot])

  useEffect(() => {
    report()
  }, [report])

  /**
   * A scrolling reader reaches the end of a chapter and keeps going.
   *
   * The neighbour is loaded only within a few pixels of the bottom, so a tall image or a late font
   * cannot pull the chapter forward while the reader is still looking at text.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || settings.readMode !== 'scroll') return
    const onScroll = () => {
      if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 8 && slot < handle.pkg.spine.length - 1) {
        anchorRef.current = { kind: 'offset', offset: 0 }
        setSlot(slot + 1)
      }
      report()
    }
    stage.addEventListener('scroll', onScroll, { passive: true })
    return () => stage.removeEventListener('scroll', onScroll)
  }, [handle.pkg.spine.length, report, settings.readMode, slot])

  const turnTo = useCallback((nextPage: number) => {
    if (nextPage >= 0 && nextPage < pages) {
      setPage(nextPage)
      return
    }
    if (nextPage < 0 && slot > 0) {
      anchorRef.current = { kind: 'end' }
      setPages(1)
      setPage(0)
      setSlot(slot - 1)
      return
    }
    if (nextPage >= pages && slot < handle.pkg.spine.length - 1) {
      anchorRef.current = { kind: 'offset', offset: 0 }
      setPages(1)
      setPage(0)
      setSlot(slot + 1)
    }
  }, [handle.pkg.spine.length, pages, slot])

  const jump = useCallback((position: BookPosition, fragment?: string) => {
    if (position.kind !== 'epub') return
    anchorRef.current = fragment
      ? { kind: 'fragment', id: fragment }
      : { kind: 'offset', offset: position.offset }
    if (position.chapter === slot) {
      relayout()
      return
    }
    setPages(1)
    setPage(0)
    setSlot(position.chapter)
  }, [relayout, slot])

  useImperativeHandle(ref, () => ({
    next: () => turnTo(settings.readMode === 'scroll' ? pages : page + 1),
    prev: () => turnTo(settings.readMode === 'scroll' ? -1 : page - 1),
    goTo: jump,
    current: () => ({ kind: 'epub', chapter: slot, offset: currentOffset() }),
    chapterIndex: () => slot,
    relayout,
  }), [currentOffset, jump, page, pages, relayout, settings.readMode, slot, turnTo])

  /**
   * A selection, converted to the chapter's own coordinates.
   *
   * `window.getSelection()` retargets into the document the reader is looking at, so the range's ends
   * are text nodes this component laid out — which is exactly what an offset needs. A selection that
   * starts outside the chapter (the HUD, the shelf behind it) is dropped rather than clamped, because a
   * clamped one would mark a passage the reader never touched.
   */
  const readSelection = useCallback((): StageSelection | null => {
    const doc = docRef.current
    const index = indexRef.current
    if (!doc || !index) return null
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return null
    const start = offsetForPoint(index, range.startContainer, range.startOffset)
    const end = offsetForPoint(index, range.endContainer, range.endOffset)
    if (start < 0 || end < 0 || end <= start) return null
    const text = selection.toString()
    if (!text.trim()) return null
    const rect = range.getBoundingClientRect()
    return { start, end, text, rect }
  }, [])

  useEffect(() => {
    const doc = docRef.current
    if (!doc) return
    const onUp = () => emit.current.onSelection(readSelection())
    const onSelectStart = () => {
      window.setTimeout(onUp, 0)
    }
    doc.addEventListener('mouseup', onUp)
    doc.addEventListener('touchend', onUp)
    doc.addEventListener('selectstart', onSelectStart)
    return () => {
      doc.removeEventListener('mouseup', onUp)
      doc.removeEventListener('touchend', onUp)
      doc.removeEventListener('selectstart', onSelectStart)
    }
  }, [readSelection])

  /** Marks and in-book links, both of which are the reader's business rather than the browser's. */
  const onClick = useCallback((event: React.MouseEvent) => {
    const doc = docRef.current
    if (!doc) return
    const mark = (event.target as HTMLElement | null)?.closest<HTMLElement>('.reader-mark')
    if (mark) {
      event.preventDefault()
      const ids = (mark.dataset.hl ?? '').split(' ').filter(Boolean)
      if (ids.length) emit.current.onMarkClick(ids, mark.getBoundingClientRect())
      return
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-href]')
    if (!link) return
    event.preventDefault()
    const href = link.dataset.readerHref ?? ''
    const target = spineIndexFor(handle.pkg, stripFragment(href))
    if (target < 0) return
    jump({ kind: 'epub', chapter: target, offset: 0 }, link.dataset.readerFragment)
  }, [handle.pkg, jump])

  const cssVars = (): Record<string, string> => ({
    '--reader-bg': theme.background,
    '--reader-fg': theme.foreground,
    '--reader-muted': theme.muted,
    '--reader-accent': theme.accent,
    '--reader-size': `${settings.fontSize}px`,
    '--reader-leading': `${settings.lineHeight}`,
    '--reader-tracking': `${settings.letterSpacing}em`,
    '--reader-para': `${settings.paragraphSpacing}`,
    '--reader-margin': `${settings.margin}px`,
    '--reader-align': settings.textAlign,
    '--reader-hyphens': settings.hyphenate ? 'auto' : 'manual',
    '--reader-font': fontStackFor(settings),
    // Scroll mode has no bars over the text, so it does not need their height reserved.
    '--reader-hud': settings.readMode === 'scroll' ? '0px' : '52px',
  })

  return (
    <div
      ref={stageRef}
      className="reader-stage"
      data-mode={settings.readMode}
      data-motion={settings.pageTurnAnimation ? 'on' : 'off'}
      style={cssVars()}
      onClick={onClick}
    >
      <style ref={styleRef} />
      <div ref={columnsRef} className="reader-columns">
        <div
          ref={docRef}
          className="reader-doc"
          data-indent={String(settings.firstLineIndent)}
          data-figures={String(settings.showFigures)}
          dir={handle.pkg.direction}
        />
      </div>
      {failed ? (
        <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[13px] text-[var(--reader-muted)]">
          {t('reading.chapter_missing')}
        </p>
      ) : null}
    </div>
  )
})

/** An id in a book is author-written, so it can contain anything a URL can. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^\w-]/g, (char) => `\\${char}`)
}
