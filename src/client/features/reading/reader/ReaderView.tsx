/**
 * One open book.
 *
 * The chrome is deliberately thin and paired: a bar above the page for the actions a reader takes
 * while reading, a bar below for where they are. Both float over the page rather than reserving a row,
 * because reserving one would re-paginate the book every time they appear — which reads as the text
 * jumping under the reader's finger.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bookmark, Clock, FileText, List, Maximize2, MoreHorizontal, PenLine, Search, Settings2 } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Menu, Tooltip, type MenuItem } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { navigateToPath } from '../../../lib/app-history'
import { useNotes } from '../../../store/notes'
import { useUi } from '../../../store/ui'
import { useLibrary } from '../store/library'
import { useReaderSettings } from '../store/reader-settings'
import { resolveReaderTheme, type ReaderThemeName } from '../themes'
import type { BookPosition } from '../position'
import { formatReadingSeconds } from '../format-time'
import { decodePosition, formatPercent } from '../position'
import type { BookRecord, Highlight } from '../types'
import { useEpubHandle } from './useEpubHandle'
import { FixedStage, type FixedStageHandle } from './FixedStage'
import { searchBook } from '../engine/book-search'
import type { PanelHit } from './SearchPanel'
import { EpubStage, type EpubStageHandle, type FootnotePreview, type StageSelection } from './EpubStage'
import { FootnotePopover } from './FootnotePopover'
import { PageStatus } from './PageStatus'
import { SelectionToolbar } from './SelectionToolbar'
import { ReaderPanel } from './ReaderPanel'
import { TocPanel } from './TocPanel'
import { AppearancePanel } from './AppearancePanel'
import { HighlightsPanel } from './HighlightsPanel'
import { MarksPanel } from './MarksPanel'
import { SearchPanel } from './SearchPanel'
import { CommentCard } from './CommentCard'
import { LookupCard } from './LookupCard'
import { useReadingTimer } from './useReadingTimer'
import { shortcutAllowedWhilePanelOpen, shortcutFor } from './shortcuts'
import { ShortcutsPanel } from './ShortcutsPanel'
import { StatsPanel } from './StatsPanel'
import { lookupSelection, vocabularyEntry, type LookupOutcome } from '../lookup'
import { ensureVocabularyNote } from '../vocabulary'

type PanelName = 'toc' | 'search' | 'marks' | 'highlights' | 'appearance' | 'shortcuts' | 'stats' | null

export function ReaderView({ book }: { book: BookRecord }) {
  const settings = useReaderSettings()
  const appTheme = useUi((state) => state.theme)
  const accentless = useUi((state) => state.background)
  const toast = useUi((state) => state.toast)
  const { handle, error } = useEpubHandle(book)
  const stage = useRef<EpubStageHandle>(null)
  const fixedStage = useRef<FixedStageHandle>(null)
  const fixedSearch = useRef<((query: string) => Promise<PanelHit[]>) | null>(null)
  const [zoom, setZoom] = useState(1)
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null)
  const isFixed = book.format !== 'epub'
  // Below the desktop breakpoint the bar keeps only where the reader is and one menu, because seven
  // icons leave no room for the title they are supposed to be beside.
  const narrow = useMedia('(max-width: 767px)')
  const [panel, setPanel] = useState<PanelName>(null)
  const [selection, setSelection] = useState<StageSelection | null>(null)
  const [footnote, setFootnote] = useState<FootnotePreview | null>(null)
  const [comment, setComment] = useState<{ ids: string[]; rect: DOMRect } | null>(null)
  const [lookup, setLookup] = useState<{ rect: DOMRect; pending: boolean; outcome: LookupOutcome | null; error: string | null; collected: boolean } | null>(null)
  const sync = useLibrary((state) => state.sync)
  const downloading = sync.phase === 'downloading' && sync.bookId === book.id
  const syncPercent = downloading && sync.total > 0 ? Math.min(1, sync.sent / sync.total) : 0
  const [chapter, setChapter] = useState(0)
  const [hudHidden, setHudHidden] = useState(false)
  const [hudPinned, setHudPinned] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrubberRef = useRef<HTMLInputElement>(null)
  const scrubbing = useRef(false)
  const [page, setPage] = useState({ page: 1, pages: 1 })
  const progress = useLibrary((state) => state.progress[book.id])
  const setProgress = useLibrary((state) => state.setProgress)
  /**
   * A `?p=` in the address wins over the saved position, because the reader followed a link that named
   * a place. It is read once and then removed: a reload of the address should resume the book rather
   * than teleport back to a link the reader has already acted on.
   */
  const linkedPosition = useRef<BookPosition | null>(null)
  const [deepLinkHandled, setDeepLinkHandled] = useState(false)
  if (!deepLinkHandled) {
    setDeepLinkHandled(true)
    linkedPosition.current = decodePosition(new URLSearchParams(window.location.search).get('p'))
    if (linkedPosition.current) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }
  const highlights = useLibrary((state) => state.highlights[book.id])
  const addHighlight = useLibrary((state) => state.addHighlight)
  const updateHighlight = useLibrary((state) => state.updateHighlight)
  const removeHighlight = useLibrary((state) => state.removeHighlight)
  const noteId = useLibrary((state) => state.notes.byBook[book.id])
  const linkNote = useLibrary((state) => state.linkNote)
  const list = highlights ?? []

  const appDark = useMemo(() => {
    if (appTheme === 'dark') return true
    if (appTheme === 'light') return false
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  }, [appTheme])
  const theme = resolveReaderTheme(settings.theme as ReaderThemeName, appDark)
  void accentless

  const busy = Boolean(panel || selection || comment) || hudPinned

  /**
   * The HUD retracts when the reader stops moving, and never while something is open.
   *
   * Hiding it under a pointer that is about to click a control is the failure mode, so the timer is
   * restarted by every pointer event rather than only by movement into the bars.
   */
  useEffect(() => {
    if (!settings.immersive || busy) {
      setHudHidden(false)
      return
    }
    let timer = 0
    const wake = () => {
      if (hudPinned) return
      setHudHidden(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setHudHidden(true), 3200)
    }
    wake()
    for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const) {
      window.addEventListener(event, wake, { passive: true })
    }
    return () => {
      window.clearTimeout(timer)
      for (const event of ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const) {
        window.removeEventListener(event, wake)
      }
    }
  }, [busy, settings.immersive])

  const onPosition = useCallback((position: BookPosition, chapterFraction: number) => {
    const total = handle?.pkg.spine.length ?? 1
    setProgress({
      bookId: book.id,
      position,
      fraction: Math.min(1, (position.kind === 'epub' ? position.chapter : 0) / Math.max(1, total)
        + chapterFraction / Math.max(1, total)),
      updatedAt: Date.now(),
      finishedAt: progress?.finishedAt ?? null,
    })
  }, [book.id, handle, progress?.finishedAt, setProgress])

  const paging = {
    zones: settings.tapZones,
    swipe: settings.swipeTurns,
    onCenterTap: () => setHudPinned((current) => !current),
  }

  /**
   * Fullscreen is asked for on the reader, not the document: the bars, the rail and the operating
   * system's own chrome are exactly what a page of text is supposed to be seen without.
   */
  const toggleFullscreen = useCallback(() => {
    const node = rootRef.current
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      return
    }
    if (!node?.requestFullscreen) return
    void node.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      toast({ title: t('reading.fullscreen_blocked'), tone: 'warning' })
    })
  }, [toast])

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const scrubTo = useCallback((fraction: number) => {
    if (isFixed) {
      const total = Math.max(1, book.unitCount)
      fixedStage.current?.goTo({ kind: 'fixed', page: Math.min(total, Math.max(1, Math.round(fraction * total))) })
      return
    }
    // The stage resolves the share against the chapter's own page count, so where the reader let go is
    // where the progress readout lands — a slider that reported somewhere else would fight the finger.
    stage.current?.goToFraction(fraction)
  }, [book.unitCount, isFixed])

  /**
   * "How much longer" is answered from the reader's own pace rather than a words-per-minute constant:
   * the time already spent on this book divided by how far through it they are. A first-time reader
   * with no elapsed time gets nothing, because a guess from page count would be a made-up number.
   */
  const minutesLeft = useMemo(() => {
    if (!settings.estimateTimeLeft) return null
    const spent = useLibrary.getState().stats[book.id]?.seconds ?? 0
    const fraction = progress?.fraction ?? 0
    if (spent < 60 || fraction < 0.03) return null
    return Math.max(1, Math.round((spent / 60) * (1 - fraction) / fraction))
  }, [book.id, progress?.fraction, settings.estimateTimeLeft])

  /**
   * The slider follows the book, but not while the reader is holding it: a page turn that lands
   * somewhere else mid-drag would yank the handle out from under the finger.
   */
  useEffect(() => {
    const node = scrubberRef.current
    if (!node || scrubbing.current) return
    const next = Math.round((progress?.fraction ?? 0) * 1000)
    if (node.value !== String(next)) node.value = String(next)
    node.style.setProperty('--pct', `${Math.round(next / 10)}%`)
  }, [progress?.fraction, settings.showScrubber])

  const goToFraction = useCallback((fraction: number) => {
    if (isFixed) {
      fixedStage.current?.goTo({ kind: 'fixed', page: Math.max(1, Math.round(fraction * Math.max(1, book.unitCount))) })
      return
    }
    stage.current?.goToFraction(fraction)
  }, [book.unitCount, isFixed])

  /**
   * Walking the reader's own marks.
   *
   * The list is ordered by chapter then offset rather than by when each was made, because a reader
   * pressing J wants the next passage further into the book, not the next one they happened to mark.
   * A step is taken from the mark the reader is standing on rather than from the top of the page: two
   * marks can share a page, and a key that stops moving is a key they will call broken. The cursor is
   * dropped the moment the page under it changes, which is the reader having moved on their own.
   */
  const cursorRef = useRef<{ chapter: number; start: number; page: string } | null>(null)
  /** The step whose page has not been reported yet, which also answers for a step that stayed on it. */
  const pendingStepRef = useRef<{ chapter: number; start: number } | null>(null)

  useEffect(() => {
    const pending = pendingStepRef.current
    if (!pending) return
    pendingStepRef.current = null
    const position = progress?.position
    cursorRef.current = position?.kind === 'epub'
      ? { chapter: pending.chapter, start: pending.start, page: `${position.chapter}:${position.offset}` }
      : null
  }, [progress?.position])

  const stepHighlight = useCallback((direction: 1 | -1) => {
    if (!list.length) {
      toast({ title: t('reading.no_highlights'), tone: 'warning' })
      return
    }
    const here = stage.current?.current() ?? fixedStage.current?.current()
    const unit = here?.kind === 'epub' ? here.chapter : here?.kind === 'fixed' ? here.page - 1 : 0
    const offset = here?.kind === 'epub' ? here.offset : 0
    const standing = cursorRef.current
    const from = pendingStepRef.current ?? (standing && standing.page === `${unit}:${offset}`
      ? { chapter: standing.chapter, start: standing.start }
      : { chapter: unit, start: offset })
    const ordered = [...list].sort((a, b) => a.chapter - b.chapter || a.start - b.start)
    const after = ordered.findIndex((one) => one.chapter > from.chapter || (one.chapter === from.chapter && one.start > from.start))
    let before = -1
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const one = ordered[i]!
      if (one.chapter < from.chapter || (one.chapter === from.chapter && one.start < from.start)) { before = i; break }
    }
    const next = direction > 0 ? ordered[after < 0 ? 0 : after] : ordered[before < 0 ? ordered.length - 1 : before]
    if (isFixed) fixedStage.current?.goTo({ kind: 'fixed', page: next.chapter + 1 })
    else stage.current?.goTo({ kind: 'epub', chapter: next.chapter, offset: next.start })
    pendingStepRef.current = isFixed ? null : { chapter: next.chapter, start: next.start }
  }, [isFixed, list, progress?.position, toast])

  const reportChapter = useCallback((index: number) => {
    setChapter(index)
    setPage((current) => ({ ...current, page: 1 }))
  }, [])

  const currentChapterTitle = handle?.pkg.spine[chapter]?.item.href.split('/').pop() ?? ''

  function turn(direction: 1 | -1): void {
    if (isFixed) {
      turnFixed(direction)
      return
    }
    setSelection(null)
    setComment(null)
    if (direction > 0) stage.current?.next()
    else stage.current?.prev()
  }

  /**
   * Keys the reader can use without looking for a button.
   *
   * Dispatched from the same table the shortcut sheet renders, and it bows out when the keystroke
   * started in a control that consumes Space or Escape — the rule the command palette follows.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inField = Boolean(target?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')
      // A field owns its keystrokes. The exception is Escape while something is open over the page:
      // that is the reader saying "get me out of here", and without it the search box would be a trap.
      // With nothing open, Escape belongs to the field itself — the page-number box uses it to cancel.
      const overlayUp = Boolean(footnote || panel || lookup || comment || selection)
      if (inField && !(event.key === 'Escape' && overlayUp)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const entry = shortcutFor(event.key)
      if (!entry) return
      if (panel && !shortcutAllowedWhilePanelOpen(entry, panel)) return
      event.preventDefault()
      switch (entry.action) {
        case 'next': turn(1); break
        case 'prev': turn(-1); break
        case 'first': goToFraction(0); break
        case 'last': goToFraction(1); break
        case 'close':
          if (comment) setComment(null)
          else if (selection) setSelection(null)
          else if (lookup) setLookup(null)
          else if (panel) setPanel(null)
          else navigateToPath('/reading')
          break
        case 'fullscreen': toggleFullscreen(); break
        case 'mark': void addMark(); break
        case 'prevHighlight': stepHighlight(-1); break
        case 'nextHighlight': stepHighlight(1); break
        default: {
          const panelName = entry.panel
          if (panelName) setPanel((current) => (current === panelName ? null : panelName))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // No dependency list on purpose: the handler reads the current panel, selection and book each
    // time, and a stale one would turn a page in a chapter the reader has already left.
  })

  /**
   * Mark the current selection.
   *
   * The quote and its neighbours are captured from the stage's own text index, so what is stored is the
   * text the reader saw rather than whatever the markup happens to say.
   */
  function mark(color: Highlight['color']): void {
    if (!selection) return
    addHighlight({
      bookId: book.id,
      chapter: selection.chapter ?? chapter,
      start: selection.start,
      end: selection.end,
      color,
      quote: selection.text,
      prefix: '',
      suffix: '',
      comment: '',
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    toast({ title: t('reading.highlight_saved'), tone: 'success' })
    ensureNoteAfterMark()
  }

  /**
   * The reader's own setting decides whether a mark files itself straight away.
   *
   * It reads the store after the write rather than this render's copy of the list, because the note has
   * to hold the mark that was just made — and it stays silent, because being taken to a note while a
   * book is open is the interruption the setting exists to allow turning off.
   */
  function ensureNoteAfterMark(): void {
    if (!settings.autoBookNote || noteId) return
    void (async () => {
      const { ensureReadingNote } = await import('../reading-note')
      const fresh = useLibrary.getState().highlights[book.id] ?? []
      const id = await ensureReadingNote(book, fresh, undefined)
      if (id) linkNote(book.id, id)
    })()
  }

  async function addMark(): Promise<void> {
    const position = stage.current?.current()
    if (!position) return
    const { prompt } = await import('../../../components/overlay')
    const label = await prompt({
      title: t('reading.new_location_mark'),
      defaultValue: t('reading.mark_default_label_value0', { value0: chapter + 1 }),
      confirmLabel: t('common.save'),
    })
    if (!label?.trim()) return
    useLibrary.getState().addMark({ bookId: book.id, label: label.trim().slice(0, 80), position })
    toast({ title: t('reading.mark_added'), tone: 'success' })
  }

  function copySelection(): void {
    if (!selection) return
    void navigator.clipboard?.writeText(selection.text).then(() => {
      toast({ title: t('reading.copied'), tone: 'success' })
    }, () => {
      toast({ title: t('reading.copy_failed'), tone: 'danger' })
    })
    setSelection(null)
  }

  function commentOnSelection(): void {
    if (!selection) return
    const created = addHighlight({
      bookId: book.id,
      chapter: selection.chapter ?? chapter,
      start: selection.start,
      end: selection.end,
      color: settings.defaultHighlightColor,
      quote: selection.text,
      prefix: '',
      suffix: '',
      comment: '',
    })
    setSelection(null)
    setComment({ ids: [created.id], rect: selection.rect })
    ensureNoteAfterMark()
  }

  const translateSelection = useCallback(async () => {
    if (!selection) return
    const rect = selection.rect
    const sentence = selection.text.length > 60 ? selection.text : ''
    setSelection(null)
    setLookup({ rect, pending: true, outcome: null, error: null, collected: false })
    try {
      const outcome = await lookupSelection(selection.text, {
        to: settings.translateTo,
        engine: settings.translateEngine,
        bookTitle: book.title,
        sentence,
      })
      setLookup({ rect, pending: false, outcome, error: null, collected: false })
    } catch (err) {
      setLookup({ rect, pending: false, outcome: null, error: err instanceof Error ? err.message : String(err), collected: false })
    }
  }, [book.title, selection, settings.translateEngine, settings.translateTo])

  const collectWord = useCallback(async (outcome: LookupOutcome) => {
    if (outcome.kind !== 'word') return
    const entry = vocabularyEntry({
      word: outcome.source,
      translation: [outcome.target, outcome.notes].filter(Boolean).join('\n'),
      sentence: selection?.text ?? outcome.source,
      bookTitle: book.title,
      link: `/reading/${encodeURIComponent(book.id)}`,
    })
    const id = await ensureVocabularyNote(entry)
    if (id) {
      setLookup((current) => (current ? { ...current, collected: true } : current))
      toast({ title: t('reading.word_collected'), tone: 'success' })
    } else {
      toast({ title: t('reading.vocabulary_failed'), tone: 'danger' })
    }
  }, [book.id, book.title, selection?.text, toast])

  const timer = useReadingTimer(book.id, settings.timerEnabled, settings.dailyGoalMinutes)

  const openNote = useCallback(async () => {
    const { ensureReadingNote } = await import('../reading-note')
    const id = await ensureReadingNote(book, list, noteId)
    if (!id) {
      toast({ title: t('reading.note_failed'), tone: 'danger' })
      return
    }
    if (id !== noteId) linkNote(book.id, id)
    navigateToPath('/notes')
    useUi.getState().openExplorer()
    void useNotes.getState().openNote(id)
  }, [book, linkNote, list, noteId, toast])

  const search = useCallback(async (term: string): Promise<PanelHit[]> => {
    if (isFixed) return (await fixedSearch.current?.(term)) ?? []
    if (!handle) return []
    const hits = await searchBook(handle, term, 400)
    return hits.map((hit) => ({ unit: hit.chapter, offset: hit.offset, before: hit.before, match: hit.match, after: hit.after }))
  }, [handle, isFixed])

  function turnFixed(direction: 1 | -1): void {
    setSelection(null)
    setComment(null)
    if (direction > 0) fixedStage.current?.next()
    else fixedStage.current?.prev()
  }

  const onFixedPosition = useCallback((position: BookPosition, fraction: number) => {
    setProgress({ bookId: book.id, position, fraction, updatedAt: Date.now(), finishedAt: progress?.finishedAt ?? null })
  }, [book.id, progress?.finishedAt, setProgress])

  const reportFixedPage = useCallback((next: number, total: number) => {
    setPage((current) => (current.page === next && current.pages === total ? current : { page: next, pages: total }))
  }, [])

  const onFixedSelection = useCallback((next: { page: number; start: number; end: number; text: string; rect: DOMRect } | null) => {
    setSelection(next ? { start: next.start, end: next.end, text: next.text, rect: next.rect, chapter: next.page - 1 } : null)
  }, [])

  function moreItems(): MenuItem[] {
    const open = (name: Exclude<PanelName, null>) => () => {
      setPanel(panel === name ? null : name)
      setMoreAt(null)
    }
    return [
      { id: 'note', label: t('reading.open_note'), onSelect: () => { setMoreAt(null); void openNote() } },
      { id: 'toc', label: t('reading.contents'), checked: panel === 'toc', onSelect: open('toc') },
      { id: 'search', label: t('reading.search_book'), checked: panel === 'search', onSelect: open('search') },
      { id: 'highlights', label: t('reading.highlights'), checked: panel === 'highlights', onSelect: open('highlights') },
      { id: 'marks', label: t('reading.location_marks'), checked: panel === 'marks', onSelect: open('marks') },
      { id: 'appearance', label: t('reading.reading_settings'), checked: panel === 'appearance', onSelect: open('appearance') },
      { id: 'shortcuts', label: t('reading.shortcuts'), checked: panel === 'shortcuts', onSelect: open('shortcuts') },
      { id: 'stats', label: t('reading.stats_title'), checked: panel === 'stats', onSelect: open('stats') },
    ]
  }

  const highlightsHere = useMemo(
    () => list.filter((one) => one.chapter === chapter).sort((a, b) => a.start - b.start),
    [chapter, list],
  )

  // A fixed-layout book reports its own failures from inside its stage; the package handle has
  // nothing useful to say about a file it was never asked to open.
  if (!isFixed && error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('reading.book_failed')}</p>
        <p className="max-w-sm text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-tertiary)]">
          {error === 'missing' ? t('reading.book_missing_hint')
            : error === 'unsupported' ? t('reading.book_unsupported_hint')
              : t('reading.book_corrupt_hint')}
        </p>
        <Button size="sm" variant="secondary" onClick={() => navigateToPath('/reading')}>
          {t('reading.back_to_shelf')}
        </Button>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col"
      data-reader-root=""
      data-page-buttons={settings.pageButtons}
      data-selection-labels={settings.selectionLabels ? 'true' : 'false'}
      data-fullscreen={fullscreen ? 'true' : 'false'}
      data-scrubber={settings.showScrubber ? 'true' : 'false'}
      style={{ background: theme.background }}
    >
      {isFixed ? (
        <FixedStage
          ref={fixedStage}
          book={book}
          settings={settings}
          theme={theme}
          highlights={list}
          start={linkedPosition.current ?? progress?.position ?? null}
          zoom={zoom}
          onPosition={onFixedPosition}
          onSelection={onFixedSelection}
          onMarkClick={(ids, rect) => {
            setSelection(null)
            setComment({ ids, rect })
          }}
          onPage={reportFixedPage}
          onSearchReady={(fn) => { fixedSearch.current = fn }}
          paging={paging}
        />
      ) : !handle ? (
        <div className="flex h-full items-center justify-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">
          {t('reading.opening_book')}
        </div>
      ) : (
        <EpubStage
          ref={stage}
          handle={handle}
          settings={settings}
          theme={theme}
          highlights={highlightsHere}
          start={linkedPosition.current ?? progress?.position ?? null}
          onPosition={onPosition}
          onPageChange={(next, total) => {
            // A card pinned to a word that has just moved off the page is a card about nothing.
            setFootnote(null)
            setPage({ page: next, pages: total })
          }}
          onSelection={setSelection}
          onFootnote={setFootnote}
          onMarkClick={(ids, rect) => {
            setSelection(null)
            setComment({ ids, rect })
          }}
          onChapter={(index) => {
            setFootnote(null)
            reportChapter(index)
          }}
          paging={paging}
        />
      )}

      {footnote ? (
        <FootnotePopover
          note={{ text: footnote.text, label: footnote.label }}
          anchor={footnote.rect}
          onJump={footnote.onJump}
          onClose={() => setFootnote(null)}
        />
      ) : null}

      <div className="reader-hud" data-edge="top" data-hidden={hudHidden ? 'true' : 'false'}>
        <IconButton label={t('reading.back_to_shelf')} size="sm" onClick={() => navigateToPath('/reading')}>
          <ArrowLeft size={15} />
        </IconButton>
        <Tooltip label={book.title} side="bottom">
          <span className="reader-title">{shortTitle(book.title)}</span>
        </Tooltip>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {settings.timerEnabled ? (
            <Tooltip label={t('reading.reading_time_hint', { value0: formatReadingSeconds(timer.todaySeconds) })} side="bottom">
              <span className="reader-pill inline-flex items-center gap-1 px-2 text-[length:var(--text-11-5)] tabular text-[var(--reader-muted)]">
                <Clock size={13} />
                {formatReadingSeconds(timer.sessionSeconds)}
              </span>
            </Tooltip>
          ) : null}
          <IconButton label={t('reading.highlights')} size="sm" active={panel === 'highlights'} onClick={() => setPanel(panel === 'highlights' ? null : 'highlights')} className={narrow ? 'hidden' : undefined}>
            <PenLine size={15} />
          </IconButton>
          <IconButton label={t('reading.open_note')} size="sm" onClick={() => void openNote()} className={narrow ? 'hidden' : undefined}>
            <FileText size={15} />
          </IconButton>
          <span className={narrow ? 'hidden' : 'contents'}>
            <IconButton label={t('reading.search_book')} size="sm" active={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}>
              <Search size={15} />
            </IconButton>
          <IconButton
            label={fullscreen ? t('reading.exit_fullscreen') : t('reading.enter_fullscreen')}
            size="sm"
            active={fullscreen}
            onClick={toggleFullscreen}
          >
            <Maximize2 size={15} />
          </IconButton>
          {isFixed ? (
            <span className="reader-pill inline-flex items-center gap-0.5 px-1">
              <IconButton label={t('reading.zoom_out')} size="xs" onClick={() => setZoom((current) => Math.max(0.5, Math.round((current - 0.25) * 100) / 100))}>
                <span className="text-[length:var(--text-13)]">-</span>
              </IconButton>
              <span className="w-9 text-center text-[length:var(--text-11)] tabular">{Math.round(zoom * 100)}%</span>
              <IconButton label={t('reading.zoom_in')} size="xs" onClick={() => setZoom((current) => Math.min(4, Math.round((current + 0.25) * 100) / 100))}>
                <span className="text-[length:var(--text-13)]">+</span>
              </IconButton>
            </span>
          ) : null}
          <IconButton label={t('reading.contents')} size="sm" active={panel === 'toc'} onClick={() => setPanel(panel === 'toc' ? null : 'toc')}>
              <List size={15} />
            </IconButton>
            <IconButton label={t('reading.location_marks')} size="sm" active={panel === 'marks'} onClick={() => setPanel(panel === 'marks' ? null : 'marks')}>
              <Bookmark size={15} />
            </IconButton>
            <IconButton label={t('reading.reading_settings')} size="sm" active={panel === 'appearance'} onClick={() => setPanel(panel === 'appearance' ? null : 'appearance')}>
              <Settings2 size={15} />
            </IconButton>
          </span>
          {narrow ? (
            <IconButton label={t('reading.more_actions')} size="sm" onClick={(event) => setMoreAt({ x: event.currentTarget.getBoundingClientRect().right - 8, y: event.currentTarget.getBoundingClientRect().bottom + 4 })}>
              <MoreHorizontal size={15} />
            </IconButton>
          ) : null}
        </div>
      </div>

      <div className="reader-hud" data-edge="bottom" data-hidden={hudHidden && settings.readMode === 'paged' ? 'true' : 'false'}>
        <IconButton label={t('reading.previous_page')} size="sm" onClick={() => turn(-1)}>
          <ArrowLeft size={15} />
        </IconButton>
        <PageStatus
          book={book}
          page={page}
          fraction={progress?.fraction ?? 0}
          chapterTitle={currentChapterTitle}
          minutesLeft={minutesLeft}
          onJump={(position, fragment) => (isFixed ? fixedStage.current?.goTo(position) : stage.current?.goTo(position, fragment))}
        />
        <IconButton label={t('reading.next_page')} size="sm" onClick={() => turn(1)}>
          <ArrowRight size={15} />
        </IconButton>
      </div>

      {settings.showScrubber ? (
        <input
          ref={scrubberRef}
          type="range"
          className="reader-scrubber ink-slider appearance-none"
          style={{ '--pct': `${Math.round((progress?.fraction ?? 0) * 100)}%` } as React.CSSProperties}
          min={0}
          max={1000}
          step={1}
          defaultValue={Math.round((progress?.fraction ?? 0) * 1000)}
          aria-label={t('reading.scrubber_label')}
          onPointerDown={() => { scrubbing.current = true }}
          onPointerUp={() => { scrubbing.current = false }}
          onPointerCancel={() => { scrubbing.current = false }}
          onChange={(event) => scrubTo(Number(event.target.value) / 1000)}
        />
      ) : null}

      {settings.dimming > 0 ? (
        <span className="reader-dim" aria-hidden="true" style={{ opacity: settings.dimming }} />
      ) : null}

      {/* A book this device never held arrives over the wire; the shelf's bar is not on this screen, so
          the page says so itself rather than showing a spinner with no reason. */}
      {downloading ? (
        <div className="reader-downloading" role="status">
          <span className="reader-downloading-label">
            {t('reading.sync_downloading_value0', { value0: book.title })}
          </span>
          <span className="reader-downloading-track">
            <span style={{ width: `${Math.round(syncPercent * 100)}%` }} />
          </span>
          <span className="reader-downloading-percent">{formatPercent(syncPercent)}</span>
        </div>
      ) : null}

      <div className="reader-progress-rail" aria-hidden="true">
        <span style={{ width: `${formatPercentNumber(progress?.fraction ?? 0)}%` }} />
      </div>

      {panel ? (
        <ReaderPanel name={panel} title={panelTitle(panel)} onClose={() => setPanel(null)} theme={theme}>
          {panel === 'toc' ? (
            <TocPanel
              book={book}
              handle={isFixed ? null : handle}
              onJump={(position, fragment) => {
                if (isFixed && position.kind === 'fixed') fixedStage.current?.goTo(position)
                else stage.current?.goTo(position, fragment)
                setPanel(null)
              }}
            />
          ) : null}
          {panel === 'appearance' ? <AppearancePanel /> : null}
          {panel === 'highlights' ? <HighlightsPanel book={book} list={list} onJump={(position) => stage.current?.goTo(position)} onRemove={(id) => removeHighlight(book.id, id)} onComment={(id, comment) => updateHighlight(book.id, id, { comment })} /> : null}
          {panel === 'marks' ? <MarksPanel bookId={book.id} onJump={(position) => stage.current?.goTo(position)} onRemove={(id) => useLibrary.getState().removeMark(book.id, id)} /> : null}
          {panel === 'shortcuts' ? <ShortcutsPanel /> : null}
          {panel === 'stats' ? <StatsPanel bookId={book.id} goalMinutes={settings.dailyGoalMinutes} /> : null}
          {panel === 'search' ? (
            <SearchPanel
              search={search}
              start={linkedPosition.current ?? progress?.position ?? null}
              fixedMode={isFixed}
              unitLabel={(unit) => (isFixed
                ? t('reading.page_value0', { value0: unit })
                : t('reading.chapter_value0', { value0: unit + 1 }))}
              onJump={(position) => (isFixed ? fixedStage.current?.goTo(position) : stage.current?.goTo(position))}
            />
          ) : null}
        </ReaderPanel>
      ) : null}

      {selection ? (
        <SelectionToolbar
          selection={selection}
          settings={settings}
          onHighlight={mark}
          onComment={commentOnSelection}
          onCopy={copySelection}
          onTranslate={() => void translateSelection()}
        />
      ) : null}

      {lookup ? (
        <LookupCard
          rect={lookup.rect}
          pending={lookup.pending}
          outcome={lookup.outcome}
          error={lookup.error}
          collected={lookup.collected}
          onCollect={(outcome) => void collectWord(outcome)}
          onClose={() => setLookup(null)}
        />
      ) : null}

      <Menu
        anchor={moreAt ?? { x: 0, y: 0 }}
        open={Boolean(moreAt)}
        onClose={() => setMoreAt(null)}
        zIndex={240}
        items={moreItems()}
      />

      {comment ? (
        <CommentCard
          ids={comment.ids}
          rect={comment.rect}
          bookId={book.id}
          theme={theme}
          onClose={() => setComment(null)}
          onEdit={(id, patch) => updateHighlight(book.id, id, patch)}
          onRemove={(id) => {
            removeHighlight(book.id, id)
            setComment(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** What the narrow bar's single menu holds: the same actions, one tap deeper. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** A title that fits the bar without hiding the controls that share it. */
function shortTitle(title: string): string {
  const characters = Array.from(title)
  return characters.length > 18 ? `${characters.slice(0, 18).join('')}…` : title
}

function panelTitle(panel: PanelName): string {
  if (panel === 'toc') return t('reading.contents')
  if (panel === 'search') return t('reading.search_book')
  if (panel === 'highlights') return t('reading.highlights')
  if (panel === 'marks') return t('reading.location_marks')
  if (panel === 'shortcuts') return t('reading.shortcuts')
  if (panel === 'stats') return t('reading.stats_title')
  return t('reading.reading_settings')
}

function formatPercentNumber(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100)
}
