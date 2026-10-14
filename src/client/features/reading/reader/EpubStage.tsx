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
import { footnotePointerOf, noteTargetFromHtml, noteTextOf } from '../engine/footnotes'
import { blockHolding, blockSpans, paintFocus } from '../engine/paragraph-focus'
import { usePointerPaging } from './usePointerPaging'
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

/** A footnote the reader is being shown without leaving the page. */
export interface FootnotePreview {
  text: string
  label: string
  rect: DOMRect
  onJump: () => void
}

export interface EpubStageHandle {
  next(): void
  prev(): void
  goTo(position: BookPosition, fragment?: string): void
  /** Land on a share of the whole book, ending on the page that shows it. */
  goToFraction(fraction: number): void
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
  /** Null when the reader has moved away from every reference. */
  onFootnote: (preview: FootnotePreview | null) => void
  onChapter: (index: number) => void
  onPageChange: (page: number, pages: number) => void
  /** Tap-zone and swipe paging, so a thumb works the way every other book app teaches it. */
  paging: { zones: 'thirds' | 'edges' | 'off'; swipe: boolean; onCenterTap: () => void }
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
  onFootnote,
  onChapter,
  onPageChange,
  paging,
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
  usePointerPaging(stageRef, {
    zones: paging.zones,
    swipe: paging.swipe,
    onNext: () => turnToRef.current(1),
    onPrev: () => turnToRef.current(-1),
    onCenterTap: paging.onCenterTap,
  })
  const turnToRef = useRef<(direction: 1 | -1) => void>(() => {})
  const geometryRef = useRef<PageGeometry>(computeGeometry(800, 1, 24))
  /** Where to land once the next chapter has laid out: an offset, or the end of the chapter. */
  const anchorRef = useRef<{ kind: 'offset'; offset: number } | { kind: 'end' } | { kind: 'fragment'; id: string } | { kind: 'fraction'; value: number } | null>(
    start?.kind === 'epub' ? { kind: 'offset', offset: start.offset } : null,
  )
  const indexRef = useRef<TextIndex | null>(null)
  /**
   * Which slot the words on the page belong to.
   *
   * A chapter switch changes `slot` a commit before the new text is on the page, and reporting during
   * that gap would publish a position made of the coming chapter and the leaving chapter's offsets.
   */
  const chapterSlotRef = useRef(-1)
  const [layoutNonce, setLayoutNonce] = useState(0)
  /**
   * The owner's callbacks live in a ref because a parent re-render hands over new function identities
   * every time. Read directly from the props inside an effect, they re-trigger the effects that depend
   * on them, which re-enter the parent's state, which re-renders — and the reader sees React's
   * "maximum update depth exceeded" instead of a page.
   */
  const emit = useRef({ onPosition, onPageChange, onSelection, onMarkClick, onChapter, onFootnote })
  useEffect(() => {
    emit.current = { onPosition, onPageChange, onSelection, onMarkClick, onChapter, onFootnote }
  })
  const lastSent = useRef('')
  /**
   * The scroll a jump of the reader's own making caused, as opposed to a thumb dragging
   * the page up. The end-of-chapter watcher below treats reaching the bottom as "keep going", and a
   * footnote at the foot of a chapter is exactly the case where a jump arrives there unasked.
   */
  const programmaticScroll = useRef(false)

  /**
   * Loading is a function of the slot, never of the call that changed it.
   *
   * A page turn, a contents jump and a restored position all end up setting `slot`, so putting the read
   * here means there is one place that can be in a half-loaded state — and `missing` is a real outcome
   * rather than a spinner that never stops.
   */
  useEffect(() => {
    let cancelled = false
    chapterSlotRef.current = -1
    setChapter(null)
    setFailed(false)
    void handle.prepare(slot).then((prepared) => {
      if (cancelled) return
      if (!prepared) {
        setFailed(true)
        return
      }
      chapterSlotRef.current = slot
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
    const columns = columnsRef.current
    // Measure the padding the stylesheet actually applied instead of re-deriving the margin here, so the
    // scroll arithmetic cannot drift away from the painted page on a window too narrow for both.
    const style = columns ? window.getComputedStyle(columns) : null
    const padding = style ? (Number.parseFloat(style.paddingInlineStart) || 0) + (Number.parseFloat(style.paddingInlineEnd) || 0) : 0
    const width = Math.max(1, (stage?.clientWidth ?? 800) - padding)
    // A phone has no room for a spread: two columns there are seven characters to a line, which is a
    // column with delusions, so the page falls back to one until there is width enough for two.
    const count = width >= 480 ? settings.columns : 1
    // The gutter between neighbouring columns is the page margin twice over: a column has a margin on
    // each side, and anything narrower lets the next page's text peek in from the edge of this one.
    const gap = Math.max(16, padding)
    return computeGeometry(width, count, gap, padding / 2)
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
    // The load effect passes through an empty chapter on the way to every jump. Laying that out would
    // spend the anchor on a page count of one and strand the reader at the top of the page that is about
    // to arrive, so there is nothing to land on until the chapter itself is here.
    if (!chapter) return
    stage.style.setProperty('--reader-column-width', `${next.columnWidth}px`)
    stage.style.setProperty('--reader-gap', `${next.gap}px`)

    if (!indexRef.current) indexRef.current = buildTextIndex(doc)
    const count = scrollMode ? 1 : measure()
    setPages(count)

    const anchor = anchorRef.current
    if (!anchor) return
    anchorRef.current = null
    if (scrollMode || count <= 1) {
      let moved = false
      if (anchor.kind === 'offset') {
        const point = pointForOffset(indexRef.current!, anchor.offset)
        const element = point?.node.parentElement
        if (element) {
          element.scrollIntoView({ block: 'start' })
          moved = true
        }
      } else if (anchor.kind === 'fragment') {
        const element = doc.querySelector<HTMLElement>(`[id="${cssEscape(anchor.id)}"]`)
        if (element) {
          element.scrollIntoView({ block: 'start' })
          moved = true
        }
      }
      if (moved) programmaticScroll.current = true
      setPage(0)
      return
    }
    let target = 0
    if (anchor.kind === 'end') {
      target = count - 1
    } else if (anchor.kind === 'fraction') {
      target = Math.round(anchor.value * Math.max(0, count - 1))
    } else if (anchor.kind === 'fragment') {
      const element = doc.querySelector<HTMLElement>(`[id="${cssEscape(anchor.id)}"]`)
      target = element ? pageForOffset(element.offsetLeft, next) : 0
    } else {
      const point = pointForOffset(indexRef.current!, anchor.offset)
      const element = point?.node.parentElement
      target = element ? pageForOffset(element.offsetLeft, next) : 0
    }
    setPage(Math.min(count - 1, Math.max(0, target)))
  }, [chapter, geometry, measure, settings.readMode])

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
    for (let at = 0; at < index.nodes.length; at++) {
      const element = index.nodes[at]!.parentElement
      if (!element) continue
      const position = scrollMode && stage ? element.offsetTop - doc.offsetTop : element.offsetLeft
      if (position + 1 >= limit) return index.starts[at] ?? 0
    }
    return index.text.length
  }, [page, settings.readMode])

  /**
   * Light the paragraph the reader is on and dim the rest.
   *
   * Paged mode reads the horizontal position because that is the axis the chapter is laid out along;
   * scroll mode reads the middle of the window, which is where their eyes are.
   */
  const paintParagraphFocus = useCallback(() => {
    const doc = docRef.current
    const stage = stageRef.current
    if (!doc || !stage) return
    if (!settings.focusParagraph) {
      paintFocus(doc, -1)
      return
    }
    const scrollMode = settings.readMode === 'scroll'
    const spans = blockSpans(doc, scrollMode ? 'y' : 'x')
    if (!spans.length) return
    const at = scrollMode ? stage.scrollTop + stage.clientHeight / 2 : page * geometryRef.current.step
    paintFocus(doc, blockHolding(spans, at))
  }, [page, settings.focusParagraph, settings.readMode])

  const report = useCallback(() => {
    const index = indexRef.current
    const stage = stageRef.current
    if (!index || chapterSlotRef.current !== slot) return
    paintParagraphFocus()
    const offset = currentOffset()
    const scrollMode = settings.readMode === 'scroll'
    const progress = scrollMode ? { page: 1, pages: 1 } : chapterProgress(page, pages)
    // How far through the chapter is a share of its prose, not of its page count: a chapter that fits
    // on one page would otherwise read as finished the moment it opened, and the scrubber could not
    // round-trip through it.
    const atEndOfBook = slot >= handle.pkg.spine.length - 1 && progress.page >= progress.pages
    const chapterFraction = atEndOfBook ? 1 : Math.min(1, offset / Math.max(1, index.text.length))
    const fraction = scrollMode && stage && stage.scrollHeight > stage.clientHeight
      ? Math.min(1, (stage.scrollTop + stage.clientHeight) / stage.scrollHeight)
      : chapterFraction
    const signature = `${slot}:${offset}:${progress.page}:${progress.pages}:${fraction.toFixed(3)}`
    if (signature === lastSent.current) return
    lastSent.current = signature
    emit.current.onPageChange(progress.page, progress.pages)
    emit.current.onPosition({ kind: 'epub', chapter: slot, offset }, fraction)
  }, [currentOffset, handle.pkg.spine.length, page, pages, paintParagraphFocus, settings.readMode, slot])

  useEffect(() => {
    report()
  }, [report])

  /**
   * Reading hands-free.
   *
   * Driven by elapsed time rather than by a fixed pixel step per frame, so the page moves the same
   * distance per second whether the display refreshes at 60 or 120 Hz. It stops by itself at the end
   * of a chapter: a reader who is not watching should arrive at a chapter break, not be scrolled past
   * it into the next one.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || settings.readMode !== 'scroll' || settings.autoScrollSpeed <= 0) return
    let frame = 0
    let previous = performance.now()
    const step = (now: number) => {
      const elapsed = now - previous
      previous = now
      if (document.visibilityState === 'visible') {
        stage.scrollTop += (settings.autoScrollSpeed * elapsed) / 1000
        const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1
        if (atEnd) return
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      if (frame) cancelAnimationFrame(frame)
    }
  }, [chapter, settings.autoScrollSpeed, settings.readMode])

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
      if (programmaticScroll.current) {
        programmaticScroll.current = false
        report()
        return
      }
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

  const jumpToFraction = useCallback((fraction: number) => {
    const total = Math.max(1, handle.pkg.spine.length)
    const scaled = Math.min(total - 0.0001, Math.max(0, fraction * total))
    const chapter = Math.floor(scaled)
    anchorRef.current = { kind: 'fraction', value: scaled - chapter }
    if (chapter === slot) {
      relayout()
      return
    }
    setPages(1)
    setPage(0)
    setSlot(chapter)
  }, [handle.pkg.spine.length, relayout, slot])

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

  /**
   * Which way the last page came in, which is what the stylesheet's slide reads.
   *
   * It is dropped for a frame before being set again, because changing an attribute alone does not
   * restart a CSS animation, and a reader who turns twice in quick succession should see two turns.
   */
  const [turn, setTurn] = useState<'next' | 'prev' | null>(null)
  const turnPhase = useRef(0)

  const markTurn = useCallback((direction: 'next' | 'prev') => {
    setTurn(null)
    const phase = ++turnPhase.current
    requestAnimationFrame(() => {
      if (turnPhase.current === phase) setTurn(direction)
    })
  }, [])

  /**
   * One turn of the page, in the direction the reader asked for.
   *
   * Paged mode moves a column; scroll mode moves a screenful and only crosses into the neighbouring
   * chapter once the reader is already at the end of this one, because a Space bar that jumps a whole
   * chapter in scroll mode reads as a lost page.
   */
  const turnPage = useCallback((direction: 1 | -1) => {
    if (settings.readMode === 'scroll') {
      const stage = stageRef.current
      if (!stage) return
      const atEdge = direction > 0
        ? stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
        : stage.scrollTop <= 2
      if (atEdge) turnTo(direction > 0 ? pages : -1)
      else stage.scrollBy({ top: direction * Math.max(80, stage.clientHeight - 64), behavior: 'smooth' })
      return
    }
    markTurn(direction > 0 ? 'next' : 'prev')
    turnTo(direction > 0 ? page + 1 : page - 1)
  }, [markTurn, page, pages, settings.readMode, turnTo])

  turnToRef.current = turnPage

  useImperativeHandle(ref, () => ({
    next: () => turnPage(1),
    prev: () => turnPage(-1),
    goTo: jump,
    goToFraction: jumpToFraction,
    current: () => ({ kind: 'epub', chapter: slot, offset: currentOffset() }),
    chapterIndex: () => slot,
    relayout,
  }), [currentOffset, jump, jumpToFraction, relayout, slot, turnPage])

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
  /** Notes already read out of another chapter, so a reader who hovers the same note twice is not
   * made to wait for the archive again. */
  const noteCache = useRef(new Map<string, string | null>())
  const hoverTimer = useRef(0)
  const hovered = useRef<HTMLElement | null>(null)

  const noteFor = useCallback(async (anchor: HTMLElement): Promise<{ text: string; chapter: number; fragment: string } | null> => {
    const doc = docRef.current
    const fragment = anchor.dataset.readerFragment ?? ''
    if (!doc || !fragment) return null
    const href = anchor.dataset.readerHref ?? ''
    // The document here is a div the chapter was painted into, so the id has to be found the way the
    // anchor jump finds it: an escaped selector, because a book's ids are author-written.
    const local = href === '' ? doc.querySelector<HTMLElement>(`[id="${cssEscape(fragment)}"]`) : null
    if (!footnotePointerOf(anchor, local)) return null
    if (local) return { text: noteTextOf(local), chapter: slot, fragment }
    const chapter = spineIndexFor(handle.pkg, stripFragment(href))
    if (chapter < 0) return null
    const key = `${chapter}#${fragment}`
    const known = noteCache.current.get(key)
    if (known !== undefined) return known ? { text: known, chapter, fragment } : null
    const prepared = await handle.prepare(chapter)
    const element = prepared ? noteTargetFromHtml(prepared.html, fragment) : null
    const text = element ? noteTextOf(element) : null
    noteCache.current.set(key, text)
    return text ? { text, chapter, fragment } : null
  }, [handle, slot])

  const showNote = useCallback((anchor: HTMLElement, note: { chapter: number; fragment: string; text: string }) => {
    emit.current.onFootnote({
      text: note.text,
      label: (anchor.textContent ?? '').trim().slice(0, 12),
      rect: anchor.getBoundingClientRect(),
      onJump: () => {
        const href = anchor.dataset.readerHref ?? ''
        const chapter = href ? spineIndexFor(handle.pkg, stripFragment(href)) : slot
        emit.current.onFootnote(null)
        if (chapter >= 0) jump({ kind: 'epub', chapter, offset: 0 }, note.fragment)
      },
    })
  }, [handle.pkg, jump, slot])

  const onPointerOver = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch') return
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-fragment]')
    if (!anchor || anchor === hovered.current) return
    hovered.current = anchor
    window.clearTimeout(hoverTimer.current)
    // A held hover is a question; a swept past one is not, and resolving the second would parse chapters
    // the reader is only scrolling by.
    hoverTimer.current = window.setTimeout(() => {
      void noteFor(anchor).then((note) => {
        if (note && hovered.current === anchor) showNote(anchor, note)
      })
    }, 180)
  }, [noteFor, showNote])

  const onPointerOut = useCallback((event: React.PointerEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-fragment]')
    if (!anchor || anchor !== hovered.current) return
    hovered.current = null
    window.clearTimeout(hoverTimer.current)
  }, [])

  const jumpTo = useCallback((link: HTMLElement) => {
    const href = link.dataset.readerHref ?? ''
    const fragment = link.dataset.readerFragment
    if (!href) {
      // Nothing to resolve: the words are already on this page, so the reader only has to be moved to them.
      jump({ kind: 'epub', chapter: slot, offset: 0 }, fragment)
      return
    }
    const target = spineIndexFor(handle.pkg, stripFragment(href))
    if (target < 0) return
    jump({ kind: 'epub', chapter: target, offset: 0 }, fragment)
  }, [handle.pkg, jump, slot])

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
    const link = (event.target as HTMLElement | null)?.closest<HTMLElement>('a[data-reader-href], a[data-reader-fragment]')
    if (!link) return
    event.preventDefault()
    // A thumb has no hover, so the first press asks the question the card answers and the card's own
    // button is what moves the page. A mouse keeps the older, quicker habit: click goes there.
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      void noteFor(link).then((note) => {
        if (note) showNote(link, note)
        else jumpTo(link)
      })
      return
    }
    jumpTo(link)
  }, [jumpTo, noteFor, showNote])

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
    // The measure is per column, so asking for a spread does not halve each page's line length.
    '--reader-columns': `${settings.columns}`,
    '--reader-align': settings.textAlign,
    '--reader-hyphens': settings.hyphenate ? 'auto' : 'manual',
    '--reader-font': fontStackFor(settings),
  })

  return (
    <div
      ref={stageRef}
      className="reader-stage"
      data-mode={settings.readMode}
      data-motion={settings.pageTurnAnimation ? 'on' : 'off'}
      style={cssVars()}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <style ref={styleRef} />
      <div ref={columnsRef} className="reader-columns" data-turn={turn ?? undefined}>
        <div
          ref={docRef}
          className="reader-doc"
          data-indent={String(settings.firstLineIndent)}
          data-figures={String(settings.showFigures)}
          data-focus={String(settings.focusParagraph)}
          dir={handle.pkg.direction}
        />
      </div>
      {failed ? (
        <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[length:var(--text-13)] text-[var(--reader-muted)]">
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
