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
import { Copy, FileType2, NotebookPen } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import type { RssEntry } from '@shared/rss/model'
import { findEntry } from '@shared/rss/reading'
import { appendToDailyNote, saveArticleAsNote } from './notes'
import { useRss } from './store'

interface Placed {
  top: number
  left: number
  text: string
}

export function ExcerptPopup({ rootRef }: { rootRef: RefObject<HTMLElement | null> }): ReturnType<typeof createPortal> | null {
  const [placed, setPlaced] = useState<Placed | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)

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

    const timer = window.setTimeout(read, 120)
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
      if (barRef.current?.contains(event.target as Node)) return
      const selection = window.getSelection()
      // A press that starts a new selection is the reader changing their mind; one that lands
      // nowhere in particular is them leaving the article.
      if (!rootRef.current?.contains(event.target as Node) && !selection?.toString()) setPlaced(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [placed, rootRef])

  if (!placed) return null

  const run = async (action: 'daily' | 'note' | 'copy'): Promise<void> => {
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

  return createPortal(
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
    </div>,
    document.body,
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
