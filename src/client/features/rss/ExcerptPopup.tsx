/**
 * The excerpt bar: what a reader can do with a piece of an article they selected.
 *
 * It is drawn in a portal on `document.body` rather than inside the article, because the reader
 * pane scrolls and an absolutely-positioned child of a scrolling column is clipped by it — and
 * because the article body is markup a stranger wrote, so a control that belongs to the app should
 * not be inside the region the app rebuilds on every article.
 *
 * The bar answers to the selection, not to the mouse: a keyboard reader who extends a selection with
 * shift-arrow gets it too, and a click that lands on one of its own buttons does not dismiss it
 * before the click arrives, which is the failure mode a "hide on any pointer-down" rule has.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Copy, FileType2, NotebookPen, Sparkles, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { prompt } from '../../components/overlay'
import type { RssEntry } from '@shared/rss/model'
import { findEntry } from '@shared/rss/reading'
import { appendToDailyNote, saveArticleAsNote } from './notes'
import { aiReady, loadAiConfig, runExcerptAi } from './ai'
import { useRss } from './store'

interface Placed {
  top: number
  left: number
  text: string
}

interface Ask {
  question: string
  text: string
  running: boolean
  error: string
  top: number
  left: number
}

/** How long a finished selection is left to settle before the popup is placed, so a drag does not open it mid-way. */
const SELECTION_SETTLE_MS = 120

export function ExcerptPopup({ rootRef }: { rootRef: RefObject<HTMLElement | null> }): ReactNode {
  const [placed, setPlaced] = useState<Placed | null>(null)
  // The answer card keeps the place it opened at: the bar follows the selection and the reader's own
  // scrolling takes it away, but a streamed answer that was asked for must survive that.
  const [ask, setAsk] = useState<Ask | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const askRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  const aiOn = useSession(state => state.settings.rss.aiEnabled)

  useEffect(() => () => abortRef.current?.(), [])

  useEffect(() => {
    const hide = (): void => setPlaced(null)

    const read = (): void => {
      const root = rootRef.current
      const selection = window.getSelection()
      if (!root || !selection || selection.rangeCount === 0) {
        setPlaced(null)
        return
      }
      const range = selection.getRangeAt(0)
      const text = selection.toString().trim()
      if (!text || text.length < 4 || !root.contains(range.commonAncestorContainer)) {
        setPlaced(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (!rect.height && !rect.width) {
        setPlaced(null)
        return
      }
      setPlaced({
        top: Math.max(8, rect.top - 40),
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 240)),
        text,
      })
    }

    const timer = window.setTimeout(read, SELECTION_SETTLE_MS)
    document.addEventListener('selectionchange', read)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('selectionchange', read)
      window.removeEventListener('scroll', hide, true)
    }
  }, [rootRef])

  useEffect(() => {
    if (!placed) return
    const onPointerDown = (event: PointerEvent): void => {
      if (barRef.current?.contains(event.target as Node) || askRef.current?.contains(event.target as Node)) return
      const selection = window.getSelection()
      // A press that starts a new selection is the reader changing their mind; one that lands
      // nowhere in particular is them leaving the article.
      if (!rootRef.current?.contains(event.target as Node) && !selection?.toString()) setPlaced(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [placed, rootRef])

  // The bar belongs to the selection and the card to the ask: typing a question into the prompt
  // collapses the selection, which takes the bar away, and an answer that was already on its way
  // must not leave with it.
  if (!placed && !ask) return null

  const run = async (action: 'daily' | 'note' | 'copy'): Promise<void> => {
    if (!placed) return
    const state = useRss.getState()
    const entry = currentEntry(state)
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(placed.text)
        useUi.getState().toast({ title: t('rss.copied'), tone: 'success' })
      }
      catch {
        useUi.getState().toast({ title: t('rss.excerpt_copy'), tone: 'danger' })
      }
      setPlaced(null)
      return
    }
    if (!entry) {
      setPlaced(null)
      return
    }
    const feed = state.library.feeds.find(item => item.id === entry.feedId)
    if (action === 'daily') {
      const outcome = await appendToDailyNote(entry, feed, placed.text)
      useUi.getState().toast(outcome === 'added'
        ? { title: t('rss.excerpt_added', { title: todayTitle() }), tone: 'success' }
        : outcome === 'already'
          ? { title: t('rss.already_added') }
          : { title: t('rss.daily_note_missing'), tone: 'danger' })
    }
    else {
      const result = await saveArticleAsNote(entry, feed, placed.text)
      useUi.getState().toast(result.ok
        ? { title: t('rss.saved_note', { title: result.title ?? '' }), tone: 'success' }
        : { title: result.error ?? t('rss.save_failed'), tone: 'danger' })
    }
    setPlaced(null)
  }

  const askAi = async (): Promise<void> => {
    const from = placed
    if (!from) return
    const question = await prompt({ title: t('rss.excerpt_ask'), placeholder: t('rss.excerpt_ask_placeholder') })
    const asked = question?.trim()
    if (!asked) return
    const state = useRss.getState()
    const entry = currentEntry(state)
    if (!entry) return
    const live = await loadAiConfig()
    if (!aiReady(live)) {
      useUi.getState().toast({ title: t('rss.ai.not_configured'), tone: 'danger' })
      return
    }
    const feed = state.library.feeds.find(item => item.id === entry.feedId)
    abortRef.current?.()
    setAsk({ question: asked, text: '', running: true, error: '', top: from.top + 46, left: Math.min(from.left, Math.max(8, window.innerWidth - 440)) })
    const run = runExcerptAi(entry, feed, asked, from.text, live, useSession.getState().settings.rss.aiLanguage, text => {
      setAsk(current => (current ? { ...current, text } : current))
    })
    abortRef.current = run.abort
    run.promise
      .then(text => setAsk(current => (current ? { ...current, text, running: false } : current)))
      .catch((error: unknown) => setAsk(current => (current ? {
        ...current,
        running: false,
        error: error instanceof Error && error.message ? error.message : t('rss.ai.failed'),
      } : current)))
      .finally(() => {
        abortRef.current = null
      })
  }

  /** The answer is kept the same way an excerpt is, and says the same three things when it is not. */
  const keepAnswer = async (text: string): Promise<void> => {
    const state = useRss.getState()
    const entry = currentEntry(state)
    if (!entry) return
    const feed = state.library.feeds.find(item => item.id === entry.feedId)
    const outcome = await appendToDailyNote(entry, feed, text)
    useUi.getState().toast(outcome === 'added'
      ? { title: t('rss.excerpt_added', { title: todayTitle() }), tone: 'success' }
      : outcome === 'already'
        ? { title: t('rss.already_added') }
        : { title: t('rss.daily_note_missing'), tone: 'danger' })
  }

  const closeAsk = (): void => {
    abortRef.current?.()
    abortRef.current = null
    setAsk(null)
  }

  return (
    <>
      {placed && createPortal(
        <div
          ref={barRef}
          role="toolbar"
          aria-label={t('rss.excerpt_note')}
          className="fixed z-[var(--z-hover-card)] flex items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-raised)] p-1 shadow-[var(--shadow-pop)]"
          style={{ top: placed.top, left: placed.left }}
        >
          <Bar onClick={() => void run('daily')} label={t('rss.excerpt_daily')} icon={<NotebookPen size={13} />} />
          <Bar onClick={() => void run('note')} label={t('rss.excerpt_note')} icon={<FileType2 size={13} />} />
          <Bar onClick={() => void run('copy')} label={t('rss.excerpt_copy')} icon={<Copy size={13} />} />
          {aiOn && <Bar onClick={() => void askAi()} label={t('rss.excerpt_ask')} icon={<Sparkles size={13} />} />}
        </div>,
        document.body,
      )}
      {ask && createPortal(
        <div
          ref={askRef}
          role="dialog"
          aria-label={t('rss.excerpt_ask')}
          className="fixed z-[var(--z-hover-card)] flex max-h-[46vh] w-[min(420px,calc(100vw-24px))] flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)]"
          style={{ top: ask.top, left: ask.left }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
            <Sparkles size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{ask.question}</span>
            {ask.running && (
              <button type="button" onClick={() => abortRef.current?.()} className="shrink-0 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">{t('rss.ai.stop')}</button>
            )}
            <button type="button" onClick={closeAsk} aria-label={t('common.close')} className="shrink-0 rounded-[var(--r-sm)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"><X size={13} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {ask.error
              ? <p className="text-[12px] text-[var(--danger)]">{ask.error}</p>
              : ask.text
                ? <p className="text-[12.5px] leading-[1.65] whitespace-pre-wrap text-[var(--text-primary)]">{ask.text}</p>
                : <p className="text-[12px] text-[var(--text-tertiary)]">{t('rss.ai.thinking')}</p>}
          </div>
          {ask.text && !ask.running && (
            <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border-subtle)] px-2 py-1.5">
              <Bar onClick={() => void navigator.clipboard.writeText(`${ask.question}\n${ask.text}`).then(() => useUi.getState().toast({ title: t('rss.copied'), tone: 'success' }), () => useUi.getState().toast({ title: t('rss.copy_failed'), tone: 'danger' }))} label={t('rss.excerpt_copy')} icon={<Copy size={13} />} />
              <Bar onClick={() => void keepAnswer(`${t('rss.excerpt_ask')}: ${ask.question}\n\n${ask.text}`)} label={t('rss.excerpt_daily')} icon={<NotebookPen size={13} />} />
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function Bar({ onClick, label, icon }: { onClick: () => void, label: string, icon: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-7 items-center gap-1.5 rounded-[var(--r-sm)] px-2 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      {icon}
      {label}
    </button>
  )
}

function currentEntry(state: ReturnType<typeof useRss.getState>): RssEntry | null {
  const entryId = state.view().entryId
  return entryId ? findEntry({ library: state.library, articles: state.articles }, entryId) ?? null : null
}

function todayTitle(): string {
  const pattern = useSession.getState().settings.rss.dailyNoteTitle
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return pattern.replace(/YYYY/g, String(now.getFullYear())).replace(/MM/g, pad(now.getMonth() + 1)).replace(/DD/g, pad(now.getDate()))
}
