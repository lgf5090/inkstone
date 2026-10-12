/**
 * The parts of the article list that are not the list: the rows, their day shelves, the sort
 * control, the bulk bar, and the divider that decides how wide all of it is.
 *
 * They live apart from `RssArticleList` because the list's job is the question "which articles is
 * this channel?" — a question of ordering, filtering and search that deserves its own tests. These
 * are the answers to "what does a row look like", and the two change for different reasons.
 */
import { useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowDownWideNarrow, Bookmark, CheckCheck, Clock, EyeOff, NotebookPen, Star, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { formatDate, shortSince } from '../../lib/time'
import { IconButton } from '../../components/primitives'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
export const MIN_LIST_WIDTH = 260
export const MAX_LIST_WIDTH = 560
import { findFeed } from '@shared/rss/reading'
import type { RssChannel, RssFilter, RssSort } from '@shared/rss/reading'
import type { MessageKey } from '@shared/locales/en-US'
import type { RssEntry, RssFeed, RssLibrary } from '@shared/rss/model'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { displayImageUrl, readingMinutes } from './sanitize'
import { appendToDailyNote, saveArticleAsNote } from './notes'
import { useRss } from './store'

export interface RowCallbacks {
  onPick: (entry: RssEntry, event: React.MouseEvent) => void
  onMenu: (entry: RssEntry, event: React.MouseEvent) => void
  onPreview: (entry: RssEntry, feed: RssFeed | undefined, rect: DOMRect) => void
}

/** The list body: rows, with a shelf label whenever the day (or the source) changes. */
export function EntryRows({ entries, library, readIds, starred, picked, selected, density, images, thumbnail, groupByDay, onPick, onMenu, onPreview }: {
  entries: RssEntry[]
  library: RssLibrary
  readIds: Set<string>
  starred: Set<string>
  picked: Set<string>
  selected: string
  density: 'comfortable' | 'compact'
  images: 'relay' | 'direct' | 'off'
  thumbnail: boolean
  groupByDay: boolean
} & RowCallbacks): ReactElement {
  const feeds = useMemo(() => new Map(library.feeds.map(feed => [feed.id, feed])), [library.feeds])
  const rows: ReactElement[] = []
  let lastShelf = ''
  for (const entry of entries) {
    const feed = feeds.get(entry.feedId)
    const shelf = groupByDay ? dayKeyOf(entry) : entry.feedId
    if (shelf !== lastShelf) {
      lastShelf = shelf
      rows.push(
        <div
          key={`shelf-${shelf}`}
          className="sticky top-0 z-10 bg-[var(--bg-base)] px-2 py-1 text-[10.5px] font-semibold tracking-[0.05em] text-[var(--text-quaternary)]"
        >
          {groupByDay ? dayLabelOf(entry) : feed?.title || t('rss.source_unknown')}
        </div>,
      )
    }
    rows.push(
      <ArticleRow
        key={entry.id}
        entry={entry}
        feed={feed}
        unread={!readIds.has(entry.id)}
        starred={starred.has(entry.id)}
        picked={picked.has(entry.id)}
        open={entry.id === selected}
        density={density}
        images={images}
        thumbnail={thumbnail}
        onPick={onPick}
        onMenu={onMenu}
        onPreview={onPreview}
      />,
    )
  }
  return <>{rows}</>
}

function dayKeyOf(entry: RssEntry): string {
  if (!entry.publishedTs) return 'undated'
  const date = new Date(entry.publishedTs)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabelOf(entry: RssEntry): string {
  if (!entry.publishedTs) return t('rss.undated')
  const now = new Date()
  const date = new Date(entry.publishedTs)
  const sameDay = date.toDateString() === now.toDateString()
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (sameDay) return t('time.today')
  if (date.toDateString() === yesterday.toDateString()) return t('time.yesterday')
  return formatDate(entry.publishedTs)
}

function ArticleRow({ entry, feed, unread, starred, picked, open, density, images, thumbnail, onPick, onMenu, onPreview }: {
  entry: RssEntry
  feed: RssFeed | undefined
  unread: boolean
  starred: boolean
  picked: boolean
  open: boolean
  density: 'comfortable' | 'compact'
  images: 'relay' | 'direct' | 'off'
  thumbnail: boolean
} & RowCallbacks): ReactElement {
  const timer = useRef(0)
  const compact = density === 'compact'
  const gutter = compact ? 22 : 44
  const picture = !compact && thumbnail && images !== 'off'
    ? displayImageUrl(entry.imageUrl, { images, relay: url => api.rss.relayUrl(url) })
    : ''
  const mark = displayImageUrl(feed?.imageUrl || '', { images, relay: url => api.rss.relayUrl(url) })
  const minutes = readingMinutes(entry)
  const hoverable = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches

  return (
    <button
      type="button"
      data-entry={entry.id}
      onClick={event => onPick(entry, event)}
      onContextMenu={event => onMenu(entry, event)}
      onMouseEnter={hoverable
        ? event => {
            const node = event.currentTarget
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => onPreview(entry, feed, node.getBoundingClientRect()), 480)
          }
        : undefined}
      onMouseLeave={() => window.clearTimeout(timer.current)}
      onFocus={() => window.clearTimeout(timer.current)}
      aria-current={open ? 'true' : undefined}
      aria-selected={picked}
      className={cn(
        'group relative flex w-full items-start gap-2.5 rounded-[var(--r-lg)] px-2 text-left',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        compact ? 'py-1.5' : 'py-2.5',
        open ? 'bg-[var(--accent-soft)]' : picked ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('relative mt-0.5 shrink-0 overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-hover)]', picked && 'ring-2 ring-[var(--accent)]')}
        style={{ width: gutter, height: gutter }}
      >
        {picture
          ? <img src={picture} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          : (
              <span className="grid size-full place-items-center text-[11px] font-semibold text-[var(--text-tertiary)]">
                {mark ? <img src={mark} alt="" loading="lazy" className="size-full object-contain p-1" /> : initialOf(feed?.title || entry.title)}
              </span>
            )}
        {unread && <span className="absolute left-0 top-0 size-2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg-base)]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[10.5px] leading-4 text-[var(--text-quaternary)]">
          <span className="min-w-0 truncate font-medium text-[var(--text-tertiary)]">{feed?.title || t('rss.source_unknown')}</span>
          {entry.publishedTs && <span className="shrink-0 tabular-nums">· {shortSince(entry.publishedTs)}</span>}
          {minutes > 0 && <span className="hidden shrink-0 tabular-nums sm:inline">· {t('rss.read_minutes', { n: minutes })}</span>}
          {starred && <Star size={10} className="shrink-0 fill-current text-[var(--accent)]" aria-hidden="true" />}
        </span>
        <span
          className={cn(
            'break-words',
            compact ? 'block truncate text-[12.5px] leading-[18px]' : 'mt-0.5 line-clamp-2 text-[13.5px] leading-[20px]',
            unread ? 'font-semibold text-[var(--text-primary)]' : 'font-normal text-[var(--text-secondary)]',
          )}
        >
          {entry.title || t('rss.untitled')}
        </span>
        {!compact && entry.summary && (
          <span className="mt-1 line-clamp-2 text-[11.5px] leading-[16px] text-[var(--text-tertiary)]">
            {entry.summary}
          </span>
        )}
      </span>
    </button>
  )
}

function initialOf(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

const SORT_KEYS: Record<RssSort, MessageKey> = {
  newest: 'rss.sort_newest',
  oldest: 'rss.sort_oldest',
  source: 'rss.sort_source',
}

export function SortButton({ sort, onPick }: { sort: RssSort, onPick: (sort: RssSort) => void }): ReactElement {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = (Object.keys(SORT_KEYS) as RssSort[]).map(key => ({
    id: key,
    label: t(SORT_KEYS[key]),
    checked: sort === key,
    onSelect: () => onPick(key),
  }))
  return (
    <>
      <Tooltip label={t('rss.sort')} side="bottom">
        <IconButton
          ref={ref}
          label={`${t('rss.sort')}: ${t(SORT_KEYS[sort])}`}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <ArrowDownWideNarrow size={14} />
        </IconButton>
      </Tooltip>
      {open && (
        <Menu anchor={ref} open onClose={() => setOpen(false)} items={items} width={176} label={t('rss.sort')} />
      )}
    </>
  )
}

/** The bar a reader gets once more than one row is picked. Every action there is one click away. */
export function BulkBar({ ids, library, onClear }: { ids: string[], library: RssLibrary, onClear: () => void }): ReactElement {
  const state = useRss()
  const read = new Set(library.readIds)
  const anyUnread = ids.some(id => !read.has(id))
  const toast = (title: string): void => {
    useUi.getState().toast({ title, tone: 'success' })
  }

  return (
    <div className="absolute inset-x-2 bottom-2 z-30 flex items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1.5 shadow-[var(--shadow-pop)]">
      <span className="min-w-0 shrink-0 text-[11.5px] font-medium tabular-nums text-[var(--text-secondary)]">
        {t('rss.picked_count', { n: ids.length })}
      </span>
      <div className="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto">
        <IconButton
          label={anyUnread ? t('rss.mark_read') : t('rss.mark_unread')}
          size="xs"
          onClick={() => {
            state.markRead(ids, !anyUnread)
            onClear()
          }}
        >
          <CheckCheck size={14} />
        </IconButton>
        <IconButton
          label={t('rss.channel_starred')}
          size="xs"
          onClick={() => {
            for (const id of ids) if (!library.favorites.includes(id)) state.toggleFavorite(id)
            onClear()
          }}
        >
          <Star size={14} />
        </IconButton>
        <IconButton
          label={t('rss.channel_later')}
          size="xs"
          onClick={() => {
            for (const id of ids) if (!library.readLater.includes(id)) state.toggleLater(id)
            onClear()
          }}
        >
          <Bookmark size={14} />
        </IconButton>
        <IconButton
          label={t('rss.add_to_daily')}
          size="xs"
          onClick={() => {
            void (async () => {
              let added = 0
              for (const id of ids) {
                const entry = findEntry(library, id)
                if (!entry) continue
                const outcome = await appendToDailyNote(entry, findFeed(library, entry.feedId))
                if (outcome === 'added') added++
              }
              toast(t('rss.bulk_daily_added', { n: added }))
              onClear()
            })()
          }}
        >
          <Clock size={14} />
        </IconButton>
        <IconButton
          label={t('rss.save_as_note')}
          size="xs"
          onClick={() => {
            void (async () => {
              let saved = 0
              for (const id of ids) {
                const entry = findEntry(library, id)
                if (!entry) continue
                const result = await saveArticleAsNote(entry, findFeed(library, entry.feedId))
                if (result.ok) saved++
              }
              toast(t('rss.bulk_notes_saved', { n: saved }))
              onClear()
            })()
          }}
        >
          <NotebookPen size={14} />
        </IconButton>
        <IconButton
          label={t('rss.hide_article')}
          size="xs"
          onClick={() => {
            state.hideEntries(ids, true)
            useUi.getState().toast({
              title: t('rss.hidden_toast', { n: ids.length }),
              action: { label: t('rss.undo'), run: () => state.hideEntries(ids, false) },
            })
            onClear()
          }}
        >
          <EyeOff size={14} />
        </IconButton>
        <IconButton label={t('rss.clear_selection')} size="xs" onClick={onClear}>
          <X size={14} />
        </IconButton>
      </div>
    </div>
  )
}

function findEntry(library: RssLibrary, id: string): RssEntry | undefined {
  const articles = useRss.getState().articles
  for (const feed of library.feeds) {
    const entry = (articles[feed.id] ?? []).find(item => item.id === id)
    if (entry) return entry
  }
  return undefined
}

/**
 * The divider between the list and the reader.
 *
 * The drag writes the host's own style rather than React state: a slider that re-rendered 60 rows
 * per pointer frame is a divider that stutters, and the committed width lands on the same value
 * React would have painted anyway.
 */
export function ListDivider({ width, onCommit }: { width: number, onCommit: (width: number) => void }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  const begin = (event: React.PointerEvent): void => {
    const host = ref.current?.parentElement
    if (!host) return
    const startX = event.clientX
    const startWidth = width
    let next = startWidth
    const move = (moveEvent: PointerEvent): void => {
      next = clampListWidth(startWidth + moveEvent.clientX - startX)
      host.style.width = `${next}px`
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      // Hand the width back to the class: an inline width left on the pane would follow
      // the reader onto a phone, where 449px of list does not fit in 420px of screen.
      host.style.width = ''
      onCommit(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    event.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('rss.resize_list')}
      aria-valuenow={width}
      aria-valuemin={MIN_LIST_WIDTH}
      aria-valuemax={MAX_LIST_WIDTH}
      tabIndex={0}
      onPointerDown={begin}
      onKeyDown={event => {
        const step = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0
        if (!step) return
        event.preventDefault()
        onCommit(clampListWidth(width + step))
      }}
      className="absolute right-0 top-0 z-20 hidden h-full w-1 cursor-col-resize bg-transparent transition-colors duration-[var(--dur-fast)] hover:bg-[var(--accent-soft)] focus-visible:bg-[var(--accent-soft)] lg:block"
    />
  )
}

function clampListWidth(value: number): number {
  return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(value)))
}

export function EmptyRow({ channel, filter, query, hasFeeds }: { channel: RssChannel, filter: RssFilter, query: string, hasFeeds: boolean }): ReactElement {
  if (query.trim()) {
    return <p className="px-3 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('rss.no_results', { query })}</p>
  }
  if (!hasFeeds) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-[13px] font-medium text-[var(--text-secondary)]">{t('rss.no_subscriptions')}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t('rss.no_subscriptions_hint')}</p>
      </div>
    )
  }
  // The saved views are empty because nothing has been marked, not because nothing arrived, so
  // their hint names the marking rather than offering a refresh that would change nothing.
  const saved = channel.kind === 'starred' || channel.kind === 'later' || channel.kind === 'recent'
  const title = saved
    ? t(channel.kind === 'starred' ? 'rss.no_starred' : channel.kind === 'later' ? 'rss.no_later' : 'rss.no_recent')
    : channel.kind === 'unread' || filter === 'unread'
      ? t('rss.no_unread')
      : filter === 'starred'
        ? t('rss.no_starred')
        : filter === 'later'
          ? t('rss.no_later')
          : t('rss.no_articles')
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>
      {!saved && (filter === 'all' || filter === 'unread') && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t('rss.no_articles_hint')}</p>
      )}
    </div>
  )
}
