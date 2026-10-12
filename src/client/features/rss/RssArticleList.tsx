/**
 * The article list: the rows a reader scans before they decide to read.
 *
 * A row is one button and holds no other control. That is not the gate's rule but the reader's: a
 * row that also carries a star, a menu and a checkbox turns every sweep of the mouse into a coin
 * flip about which of the four things got hit. Everything a row can *do* beyond opening happens in
 * the reader or in the row's own right-click menu, and picking several rows at once is a modifier
 * click on the row itself — the same gesture the file list already uses.
 *
 * The list draws at most `PAGE` rows and offers the rest behind a click. A merged channel of 400
 * feeds is a few thousand nodes, and a reader who scrolls that far is rare enough that the extra
 * paint is not worth the first frame's cost.
 *
 * The right edge is a divider. A 320px list is right for scanning headlines and wrong for a wide
 * monitor with an article open beside it, and only the reader knows which they are doing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CheckCheck, RefreshCw, Settings2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { compileQuery } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { useSession } from '../../store/session'
import { Button, IconButton } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Segmented } from '../../components/form'
import { Menu, Tooltip, useContextMenu } from '../../components/overlay'
import {
  channelEntries,
  findFeed,
  selectEntries,
  sortEntries,
  stepIndex,
  type RssFilter,
} from '@shared/rss/reading'
import type { RssEntry, RssFeed } from '@shared/rss/model'
import { searchEntries } from './search'
import { entryMenuItems } from './rssMenus'
import { ArticlePreviewCard } from './ArticlePreviewCard'
import { BulkBar, EmptyRow, EntryRows, ListDivider, MAX_LIST_WIDTH, MIN_LIST_WIDTH, SortButton } from './RssListParts'
import { useRss } from './store'

const PAGE = 60

export function RssArticleList({ onOpen, onManage }: { onOpen: () => void, onManage: () => void }) {
  const state = useRss()
  const settings = useSession(session => session.settings.rss)
  const update = useSession(session => session.updateSettings)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [lastPicked, setLastPicked] = useState('')
  const [preview, setPreview] = useState<{ entry: RssEntry, feed?: RssFeed, rect: DOMRect } | null>(null)
  const view = state.view()
  const pinyinVersion = usePinyinVersion()
  const query = useMemo(() => compileQuery(view.query), [view.query, pinyinVersion])

  const entries = useMemo(() => {
    const all = channelEntries({ library: state.library, articles: state.articles }, state.channel)
    const ordered = sortEntries(all, view.sort, state.library.feeds)
    const filtered = selectEntries(ordered, { filter: view.filter }, { library: state.library, articles: state.articles })
    if (!query.text || query.error) return filtered
    const names = new Map(state.library.feeds.map(feed => [feed.id, feed.title]))
    return searchEntries(filtered, query, names).map(item => item.entry)
  }, [state.library, state.articles, state.channel, view.filter, view.sort, query, pinyinVersion])

  const readIds = useMemo(() => new Set(state.library.readIds), [state.library.readIds])
  const starred = useMemo(() => new Set(state.library.favorites), [state.library.favorites])
  const shown = entries.slice(0, limit)
  const selected = view.entryId
  const unreadIds = useMemo(() => entries.filter(entry => !readIds.has(entry.id)).map(entry => entry.id), [entries, readIds])
  const refreshing = state.refreshing.length > 0
  const [markArmed, setMarkArmed] = useState(false)
  const menu = useContextMenu()
  const [menuEntry, setMenuEntry] = useState<RssEntry | null>(null)
  const channelFeeds = state.channel.kind === 'feed'
    ? [state.channel.feedId]
    : state.channel.kind === 'group'
      ? state.library.feeds.filter(feed => feed.groupId === (state.channel as { groupId: string }).groupId).map(feed => feed.id)
      : state.library.feeds.map(feed => feed.id)

  useEffect(() => {
    setLimit(PAGE)
  }, [state.channel])

  // Arm on the first press, act on the second: this marks every loaded row of the channel, and the
  // count in the label is the only place the reader sees how wide that is.
  useEffect(() => {
    setMarkArmed(false)
  }, [state.channel, view.filter, unreadIds.length])

  useEffect(() => {
    setPicked(new Set())
    setLastPicked('')
  }, [state.channel])

  useEffect(() => {
    const host = listRef.current
    if (!host) return
    host.scrollTop = view.listTop
  }, [state.channel])

  useEffect(() => {
    if (!selected) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(selected)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const pick = useCallback((entry: RssEntry, event: React.MouseEvent): void => {
    const index = entries.findIndex(item => item.id === entry.id)
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(picked)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      setPicked(next)
      setLastPicked(entry.id)
      return
    }
    if (event.shiftKey && lastPicked && index >= 0) {
      const from = entries.findIndex(item => item.id === lastPicked)
      if (from >= 0) {
        const [lo, hi] = from <= index ? [from, index] : [index, from]
        const next = new Set(picked)
        for (const item of entries.slice(lo, hi + 1)) next.add(item.id)
        setPicked(next)
        return
      }
    }
    state.openEntry(entry.id)
    onOpen()
  }, [entries, lastPicked, onOpen, picked, state])

  // Keyboard: j/k walk the list, Enter opens, x picks, s stars, Escape leaves the selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (event.key === 'Escape') {
        if (picked.size) {
          setPicked(new Set())
          event.preventDefault()
        }
        return
      }
      if (event.key === 'r') {
        event.preventDefault()
        void state.refresh(channelFeeds, { force: true })
        return
      }
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'Enter' && event.key !== 'x' && event.key !== 's' && event.key !== 'm' && event.key !== 'v') return
      const current = entries.findIndex(entry => entry.id === selected)
      if (event.key === 'm' && current >= 0) {
        event.preventDefault()
        state.markRead([entries[current].id], readIds.has(entries[current].id))
        return
      }
      if (event.key === 'v' && current >= 0 && entries[current].link) {
        event.preventDefault()
        window.open(entries[current].link, '_blank', 'noopener,noreferrer')
        return
      }
      if (event.key === 'Enter') {
        if (current < 0) return
        event.preventDefault()
        state.openEntry(entries[current].id)
        onOpen()
        return
      }
      if (event.key === 'x' || event.key === 's') {
        if (current < 0) return
        event.preventDefault()
        if (event.key === 's') {
          state.toggleFavorite(entries[current].id)
          return
        }
        const next = new Set(picked)
        if (next.has(entries[current].id)) next.delete(entries[current].id)
        else next.add(entries[current].id)
        setPicked(next)
        setLastPicked(entries[current].id)
        return
      }
      const next = stepIndex(current, event.key === 'j' ? 1 : -1, entries.length)
      if (next < 0) return
      event.preventDefault()
      if (next >= limit) setLimit(next + PAGE)
      state.openEntry(entries[next].id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [entries, selected, limit, state, onOpen, picked, readIds, channelFeeds])

  // Scrolling past a row is how a reader finishes a channel: the list marks what has gone above the
  // top edge, so a long morning of reading does not end with forty rows still showing as new.
  const markScrolled = useCallback((node: HTMLElement) => {
    if (!settings.markReadOnScroll) return
    const edge = node.getBoundingClientRect().top
    const done: string[] = []
    for (const row of node.querySelectorAll<HTMLElement>('[data-entry]')) {
      if (row.getBoundingClientRect().bottom < edge) done.push(row.dataset.entry!)
      else break
    }
    const fresh = done.filter(id => !readIds.has(id))
    if (fresh.length) state.markRead(fresh, true)
  }, [readIds, settings.markReadOnScroll, state])

  const title = channelTitle(state)
  const width = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, settings.listWidth))

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)] lg:w-[var(--list-w)] lg:shrink-0"
      style={{ '--list-w': `${width}px` } as CSSProperties}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
        <div className="min-w-0 flex-1">
          <FilterInput
            value={view.query}
            onChange={state.setQuery}
            query={query}
            label={t('rss.search_articles')}
            size="sidebar"
          />
        </div>
        <Tooltip label={t('rss.refresh_channel')} side="bottom">
          <IconButton
            label={t('rss.refresh_channel')}
            size="sm"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => void state.refresh(channelFeeds, { force: true })}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('rss.manage')} side="bottom">
          <IconButton label={t('rss.manage')} size="sm" onClick={onManage}>
            <Settings2 size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-2 pb-2">
        <Segmented
          size="sm"
          label={t('rss.filter_all')}
          value={view.filter}
          onChange={filter => state.setFilter(filter as RssFilter)}
          options={[
            { value: 'all', label: t('rss.filter_all') },
            { value: 'unread', label: t('rss.filter_unread') },
            { value: 'starred', label: t('rss.filter_starred') },
            { value: 'later', label: t('rss.filter_later') },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <SortButton sort={view.sort} onPick={state.setSort} />
          {unreadIds.length > 0 && (
            <Tooltip
              label={markArmed ? t('rss.mark_channel_read_confirm', { n: unreadIds.length }) : t('rss.mark_channel_read')}
              side="bottom"
            >
              <IconButton
                label={markArmed ? t('rss.mark_channel_read_confirm', { n: unreadIds.length }) : t('rss.mark_channel_read')}
                size="sm"
                className={markArmed ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : undefined}
                onClick={() => {
                  if (!markArmed) {
                    setMarkArmed(true)
                    return
                  }
                  setMarkArmed(false)
                  state.markRead(unreadIds, true)
                }}
              >
                <CheckCheck size={14} />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>
      <h2 className="sr-only">{title}</h2>
      <div
        ref={listRef}
        onScroll={(event) => {
          state.setListTop(event.currentTarget.scrollTop)
          setPreview(null)
          markScrolled(event.currentTarget)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-3"
      >
        <EntryRows
          entries={shown}
          library={state.library}
          readIds={readIds}
          starred={starred}
          picked={picked}
          selected={selected}
          density={settings.density}
          images={settings.images}
          thumbnail={settings.showThumbnails}
          groupByDay={view.sort !== 'source'}
          onPick={pick}
          onMenu={(entry, event) => {
            setPreview(null)
            setMenuEntry(entry)
            menu.onContextMenu(event)
          }}
          onPreview={(entry, feed, rect) => setPreview({ entry, feed, rect })}
        />
        {entries.length > limit && (
          <div className="px-2 pt-2">
            <Button size="sm" block onClick={() => setLimit(value => value + PAGE)}>{t('rss.load_more')}</Button>
          </div>
        )}
        {!entries.length && <EmptyRow channel={state.channel} filter={view.filter} query={view.query} hasFeeds={state.library.feeds.length > 0} />}
      </div>

      {picked.size > 0 && (
        <BulkBar
          ids={[...picked]}
          library={state.library}
          onClear={() => setPicked(new Set())}
        />
      )}

      <ListDivider
        width={width}
        onCommit={listWidth => update({ rss: { listWidth } })}
      />

      {menuEntry && (
        <Menu
          anchor={menu.point ?? { x: 0, y: 0 }}
          open={!!menu.point}
          onClose={() => {
            menu.close()
            setMenuEntry(null)
          }}
          items={entryMenuItems(menuEntry, state.library, {
            onOpen: () => {
              state.openEntry(menuEntry.id)
              onOpen()
            },
          })}
          width={224}
          label={t('rss.menu_article')}
          searchable
          searchPlaceholder={t('rss.menu_search')}
        />
      )}

      {preview && (
        <ArticlePreviewCard
          entry={preview.entry}
          feed={preview.feed}
          anchor={preview.rect}
          images={settings.images}
          onDismiss={() => setPreview(null)}
        />
      )}
    </div>
  )
}

function channelTitle(state: ReturnType<typeof useRss.getState>): string {
  const { library, channel } = state
  if (channel.kind === 'feed') return findFeed(library, channel.feedId)?.title ?? t('rss.source_unknown')
  if (channel.kind === 'group') return library.groups.find(group => group.id === channel.groupId)?.name ?? t('rss.subscriptions')
  if (channel.kind === 'tag') return channel.tag
  if (channel.kind === 'starred') return t('rss.channel_starred')
  if (channel.kind === 'later') return t('rss.channel_later')
  if (channel.kind === 'unread') return t('rss.channel_unread')
  if (channel.kind === 'recent') return t('rss.channel_recent')
  return t('rss.channel_all')
}
