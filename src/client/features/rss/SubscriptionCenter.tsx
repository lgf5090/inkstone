/**
 * The one dialog where subscriptions are read and maintained.
 *
 * The reference reader this port follows keeps both tabs mounted while the dialog is open, and that
 * is the behaviour copied here rather than the layout: a reader who searches, selects four feeds,
 * glances at the catalogue and comes back has not asked to lose the search, the scroll position or
 * the selection. Two tabs that rebuild on switch make "manage my library" a series of small losses.
 *
 * Reading lives in the rail and the list; maintenance lives here. The dialog therefore has no
 * preview of an article at all — it previews a *feed*, which is the thing a reader is deciding
 * about.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, Download, FolderPlus, MoreHorizontal, Pause, Play, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { cn } from '../../lib/cn'
import { folderPath } from '../../lib/folders'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Segmented } from '../../components/form'
import { Menu, Modal, confirm, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { FilterInput } from '../../components/FilterInput'
import { compileQuery, queryMatches } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { exportOpml, parseOpml } from '../../lib/rss/feed'
import { canonicalFeedUrl, RSS_LIMITS, safeHttpUrl, type RssFeed } from '@shared/rss/model'
import { groupedFeeds } from '@shared/rss/reading'
import { shortSince } from '../../lib/time'
import { api } from '../../lib/api'
import { useRss } from './store'
import { feedCacheLine } from './cacheLine'
import { copyFeedUrlItem } from './rssMenus'
import { filterSources, loadDiscovery, topTags, type DiscoveryCatalog, type DiscoverySource, type ShelfName } from './discovery'

type Tab = 'manage' | 'discover'

export function SubscriptionCenter({ onClose, adding = false, tab: initialTab = 'manage' }: { onClose: () => void, adding?: boolean, tab?: Tab }): ReactElement {
  // Which shelf the palette named is only an opening position: both tabs stay mounted, so a reader
  // who walks over to the catalogue and back keeps their search, their scroll and their selection.
  const [tab, setTab] = useState<Tab>(initialTab)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('rss.manage')}
      width={920}
      bodyClassName="p-0"
      className="max-h-[88vh]"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-3">
        <TabButton active={tab === 'manage'} onClick={() => setTab('manage')} label={t('rss.manage')} />
        <TabButton active={tab === 'discover'} onClick={() => setTab('discover')} label={t('rss.discover')} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('h-full min-h-0', tab === 'manage' ? 'block' : 'hidden')}>
          <ManagePanel adding={adding} onAdded={onClose} />
        </div>
        <div className={cn('h-full min-h-0', tab === 'discover' ? 'block' : 'hidden')}>
          <DiscoverPanel />
        </div>
      </div>
    </Modal>
  )
}

function TabButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        '-mb-px border-b-2 px-3 py-2.5 text-[12.5px] font-medium transition-colors duration-[var(--dur-fast)]',
        active
          ? 'border-[var(--accent)] text-[var(--text-primary)]'
          : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
      )}
    >
      {label}
    </button>
  )
}

function ManagePanel({ adding, onAdded }: { adding: boolean, onAdded: () => void }): ReactElement {
  const library = useRss(state => state.library)
  const store = useRss()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [showAdd, setShowAdd] = useState(adding)
  const pinyinVersion = usePinyinVersion()
  const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion])

  const groups = useMemo(() => groupedFeeds(library), [library])
  const visible = useMemo(() => groups.map((entry) => {
    const feeds = entry.feeds.filter(feed => !compiled.text || compiled.error || queryMatches(compiled, feed.title) || queryMatches(compiled, feed.url))
    return { ...entry, feeds }
  }).filter(entry => entry.feeds.length), [groups, compiled, pinyinVersion])

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exportOpmlFile = (): void => {
    const xml = exportOpml(library.feeds.map(feed => ({
      url: feed.url,
      title: feed.title,
      groupPath: folderPath(library.groups, feed.groupId).map(group => group.name),
      siteUrl: feed.siteUrl,
    })), 'Inkstone subscriptions')
    const url = URL.createObjectURL(new Blob([xml], { type: 'text/x-opml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `inkstone-subscriptions-${new Date().toISOString().slice(0, 10)}.opml`
    link.click()
    // The blob is read when the click is handled, not when it is queued, so it outlives this tick.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    useUi.getState().toast({ title: t('rss.opml_exported'), tone: 'success' })
  }

  const bulkUnsubscribe = async (): Promise<void> => {
    const count = selected.size
    if (!count) return
    if (!(await confirm({ title: t('rss.unsubscribe_many', { n: count }), tone: 'danger', confirmLabel: t('rss.unsubscribe') }))) return
    for (const id of selected) store.removeFeed(id)
    setSelected(new Set())
  }

  const bulkRefresh = async (): Promise<void> => {
    const ids = [...selected]
    setSelected(new Set())
    if (ids.length) await store.refresh(ids, { force: true })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="min-w-[180px] flex-1">
          <FilterInput value={query} onChange={setQuery} query={compiled} label={t('rss.search_articles')} size="sidebar" />
        </div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => setShowAdd(true)}>{t('rss.add_subscription')}</Button>
        <Button size="sm" icon={<Upload size={13} />} onClick={() => setImporting('')}>{t('rss.opml_import')}</Button>
        <Button size="sm" icon={<Download size={13} />} onClick={exportOpmlFile}>{t('rss.opml_export')}</Button>
        <span className="ml-auto text-[11px] text-[var(--text-quaternary)]">
          {t('rss.subscriptions_count', { n: library.feeds.length })}
          {library.feeds.length >= RSS_LIMITS.feeds ? ` · ${t('rss.error.feed_limit', { n: RSS_LIMITS.feeds })}` : ''}
        </span>
      </div>

      {showAdd && <AddFeedForm onDone={() => setShowAdd(false)} onAdded={onAdded} />}

      {selected.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5">
          <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">{t('rss.selected_n', { n: selected.size })}</span>
          <Button size="sm" onClick={() => void bulkRefresh()}>{t('rss.refresh')}</Button>
          <Button size="sm" variant="danger" onClick={() => void bulkUnsubscribe()}>{t('rss.unsubscribe')}</Button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            {t('rss.clear_selection')}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!visible.length && (
          <p className="py-10 text-center text-[12.5px] text-[var(--text-tertiary)]">
            {query.trim() ? t('rss.no_results', { query }) : t('rss.no_subscriptions')}
          </p>
        )}
        {visible.map(({ group, feeds }) => (
          <section key={group?.id ?? 'ungrouped'} className="mb-3">
            <div className="flex items-center gap-2 px-1 py-1">
              <h3 className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-[var(--text-secondary)]">
                {group?.name ?? t('rss.ungrouped')}
              </h3>
              <button
                type="button"
                onClick={() => setSelected(current => new Set([...current, ...feeds.map(feed => feed.id)]))}
                className="rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                {t('rss.select_all')}
              </button>
              {group && (
                <>
                  <button
                    type="button"
                    onClick={() => void renameGroup(group.id, group.name)}
                    className="rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    {t('rss.rename_group')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeGroup(group.id, group.name)}
                    className="rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
                  >
                    {t('rss.delete_group')}
                  </button>
                </>
              )}
            </div>
            {feeds.map(feed => (
              <FeedRow
                key={feed.id}
                feed={feed}
                group={group?.name ?? ''}
                selected={selected.has(feed.id)}
                menuOpen={menuFor === feed.id}
                onToggleSelect={toggle}
                onMenu={(open) => setMenuFor(open ? feed.id : null)}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
        <Button size="sm" variant="ghost" icon={<FolderPlus size={13} />} onClick={() => void newGroup()}>{t('rss.new_group')}</Button>
        <input ref={fileRef} type="file" hidden accept=".opml,.xml" onChange={event => void readOpml(event.target.files?.[0]).then((text) => { if (text !== null) setImporting(text) })} />
      </div>

      {importing !== null && (
        <OpmlImport initial={importing} onClose={() => setImporting(null)} onFile={() => fileRef.current?.click()} />
      )}
    </div>
  )
}

async function newGroup(): Promise<void> {
  const name = await prompt({ title: t('rss.new_group'), placeholder: t('rss.group_name') })
  if (name) useRss.getState().addGroup(name)
}

async function renameGroup(id: string, current: string): Promise<void> {
  const name = await prompt({ title: t('rss.rename_group'), defaultValue: current })
  if (name) useRss.getState().renameGroup(id, name)
}

async function removeGroup(id: string, name: string): Promise<void> {
  if (await confirm({ title: t('rss.delete_group_confirm', { name }), tone: 'danger', confirmLabel: t('rss.delete_group') })) {
    useRss.getState().removeGroup(id)
  }
}

async function readOpml(file: File | undefined): Promise<string | null> {
  if (!file) return null
  // A 5 MB OPML is a large library; the preview reads it all, so the ceiling is the file reader's, not ours.
  return file.text()
}

function FeedRow({ feed, group, selected, menuOpen, onToggleSelect, onMenu }: {
  feed: RssFeed
  group: string
  selected: boolean
  menuOpen: boolean
  onToggleSelect: (id: string) => void
  onMenu: (open: boolean) => void
}): ReactElement {
  const anchor = useRef<HTMLButtonElement | null>(null)
  // The durable ledger, not what happens to be in memory: this row answers "what is on this device
  // for this subscription", including for the forty feeds the reader has not opened today.
  const cache = useRss(state => state.cache)
  const items = useMemo(() => {
    const groups: MenuItem[] = [
      { id: 'none', label: t('rss.ungrouped'), onSelect: () => useRss.getState().moveFeed(feed.id, '') },
      ...useRss.getState().library.groups.map(group => ({
        id: group.id,
        label: group.name,
        onSelect: () => useRss.getState().moveFeed(feed.id, group.id),
      })),
      { id: 'new', label: t('rss.new_group'), onSelect: () => void newGroupThenMove(feed.id) },
    ]
    return [
      {
        id: 'rename',
        label: t('rss.rename_feed'),
        onSelect: async () => {
          const name = await prompt({ title: t('rss.rename_feed'), defaultValue: feed.title })
          if (name) useRss.getState().renameFeed(feed.id, name)
        },
      },
      {
        id: 'move',
        label: t('rss.move_group'),
        submenu: submenuFor(groups),
        subItems: groups,
      },
      {
        id: 'pause',
        label: feed.paused ? t('rss.resume') : t('rss.pause'),
        icon: feed.paused ? <Play size={13} /> : <Pause size={13} />,
        onSelect: () => useRss.getState().setPaused(feed.id, !feed.paused),
      },
      {
        id: 'refresh',
        label: t('rss.refresh'),
        icon: <RefreshCw size={13} />,
        onSelect: () => void useRss.getState().refresh([feed.id], { force: true }),
      },
      copyFeedUrlItem(feed),
      {
        id: 'unsubscribe',
        label: t('rss.unsubscribe'),
        icon: <Trash2 size={13} />,
        tone: 'danger' as const,
        onSelect: async () => {
          if (await confirm({ title: t('rss.unsubscribe_confirm', { name: feed.title }), tone: 'danger', confirmLabel: t('rss.unsubscribe') })) {
            useRss.getState().removeFeed(feed.id)
            useUi.getState().toast({ title: t('rss.unsubscribed', { name: feed.title }), tone: 'success' })
          }
        },
      },
    ]
  }, [feed.id, feed.paused, feed.title])

  return (
    <div className="flex items-center gap-2 rounded-[var(--r-md)] px-1.5 py-1 hover:bg-[var(--bg-hover)]">
      <Checkbox checked={selected} onChange={() => onToggleSelect(feed.id)} label={`${t('rss.subscriptions')}: ${feed.title}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">{feed.title}</span>
          {feed.paused && <span className="shrink-0 text-[10px] text-[var(--text-quaternary)]">{t('rss.paused')}</span>}
        </div>
        <div className="min-w-0 truncate text-[10.5px] text-[var(--text-quaternary)]">
          {feed.error
            ? <span className="text-[var(--danger)]">{feed.error}</span>
            : feedCacheLine(cache[feed.id])}
          {!feed.error && group ? ` · ${group}` : ''}
        </div>
      </div>
      <button
        ref={anchor}
        type="button"
        aria-label={`${t('rss.rename_feed')} · ${feed.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => onMenu(!menuOpen)}
        className="flex size-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] hover:text-[var(--text-primary)]"
      >
        <MoreHorizontal size={14} />
      </button>
      <Menu anchor={anchor} open={menuOpen} onClose={() => onMenu(false)} items={items} align="end" />
    </div>
  )
}

async function newGroupThenMove(feedId: string): Promise<void> {
  const name = await prompt({ title: t('rss.new_group'), placeholder: t('rss.group_name') })
  if (!name) return
  const id = useRss.getState().addGroup(name)
  if (id) useRss.getState().moveFeed(feedId, id)
}

function AddFeedForm({ onDone, onAdded }: { onDone: () => void, onAdded: () => void }): ReactElement {
  const [url, setUrl] = useState('')
  const [group, setGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ name: string, count: number, newest: number } | null>(null)
  const library = useRss(state => state.library)
  const store = useRss()

  useEffect(() => {
    setPreview(null)
    setError('')
    const written = safeHttpUrl(url)
    if (!written) return
    const timer = window.setTimeout(async () => {
      setBusy(true)
      try {
        const result = (await api.rss.fetch([{ url: written.href }])).results[0]
        if (!result?.ok || !result.xml) {
          setError(result?.reason ? reasonText(result.reason) : t('rss.error.unreachable'))
          return
        }
        const { parseFeed } = await import('../../lib/rss/feed')
        const parsed = parseFeed(result.xml, written.href)
        setPreview({ name: parsed.title, count: parsed.entries.length, newest: parsed.entries[0]?.publishedTs ?? 0 })
      }
      catch (error: unknown) {
        setError(error instanceof Error && error.message ? error.message : t('rss.error.unreachable'))
      }
      finally {
        setBusy(false)
      }
    }, 500)
    return () => window.clearTimeout(timer)
  }, [url])

  const add = async (): Promise<void> => {
    setBusy(true)
    const result = await store.addFeed(url, group ? store.addGroup(group) : '')
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? t('rss.error.unreachable'))
      return
    }
    useUi.getState().toast({ title: t('rss.subscribed'), tone: 'success' })
    onAdded()
  }

  const duplicate = library.feeds.some(feed => canonicalFeedUrl(feed.url) === canonicalFeedUrl(safeHttpUrl(url)?.href ?? ''))

  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('rss.feed_url')} className="min-w-[240px] flex-1">
          <Input value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" autoFocus />
        </Field>
        <Field label={t('rss.group_optional')} className="w-[160px]">
          <Input value={group} onChange={event => setGroup(event.target.value)} list="rss-group-names" />
        </Field>
        <Button size="sm" onClick={() => void add()} loading={busy} disabled={!safeHttpUrl(url) || duplicate}>
          {t('rss.add')}
        </Button>
        <IconButton label={t('common.close')} size="sm" onClick={onDone}>
          <ChevronDown size={15} />
        </IconButton>
      </div>
      <datalist id="rss-group-names">
        {library.groups.map(entry => <option key={entry.id} value={entry.name} />)}
      </datalist>
      {duplicate && <p className="mt-1.5 text-[11.5px] text-[var(--danger)]">{t('rss.error.already_subscribed')}</p>}
      {error && !duplicate && <p className="mt-1.5 text-[11.5px] text-[var(--danger)]">{error}</p>}
      {preview && (
        <p className="mt-1.5 text-[11.5px] text-[var(--text-secondary)]">
          {preview.name} · {t('rss.preview_count', { n: preview.count, date: preview.newest ? shortSince(preview.newest) : '—' })}
        </p>
      )}
      {!preview && !error && <p className="mt-1.5 text-[11.5px] text-[var(--text-quaternary)]">{t('rss.add_subscription_hint')}</p>}
    </div>
  )
}

function OpmlImport({ initial, onClose, onFile }: { initial: string, onClose: () => void, onFile: () => void }): ReactElement {
  const [text, setText] = useState(initial)
  const store = useRss()
  const parsed = useMemo(() => {
    if (!text.trim()) return null
    try {
      return parseOpml(text)
    }
    catch {
      return { feeds: [], skipped: 0 }
    }
  }, [text])

  const run = async (): Promise<void> => {
    if (!parsed?.feeds.length) return
    const added = await store.importFeeds(parsed.feeds)
    useUi.getState().toast({ title: t('rss.opml_imported', { n: added }), tone: 'success' })
    onClose()
  }

  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Upload size={13} />} onClick={onFile}>{t('rss.opml_import')}</Button>
        <span className="text-[11.5px] text-[var(--text-quaternary)]">{t('rss.opml_paste')}</span>
        <IconButton label={t('common.close')} size="sm" className="ml-auto" onClick={onClose}>
          <ChevronDown size={15} />
        </IconButton>
      </div>
      <textarea
        value={text}
        onChange={event => setText(event.target.value)}
        rows={5}
        spellCheck={false}
        aria-label={t('rss.opml_paste')}
        className="w-full rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] p-2 font-mono text-[11.5px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
      />
      {parsed && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11.5px] text-[var(--text-secondary)]">
            {parsed.feeds.length ? t('rss.opml_preview', { n: parsed.feeds.length, skipped: parsed.skipped }) : t('rss.opml_empty')}
          </span>
          <Button size="sm" className="ml-auto" disabled={!parsed.feeds.length} onClick={() => void run()}>{t('rss.add')}</Button>
        </div>
      )}
    </div>
  )
}

function DiscoverPanel(): ReactElement {
  const library = useRss(state => state.library)
  const store = useRss()
  const [catalog, setCatalog] = useState<DiscoveryCatalog | null>(null)
  const [failed, setFailed] = useState(false)
  const [shelf, setShelf] = useState<ShelfName>('featured')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [limit, setLimit] = useState(40)

  useEffect(() => {
    loadDiscovery().then(setCatalog).catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    setLimit(40)
    setTag('')
  }, [shelf])

  const subscribed = useMemo(() => new Set(library.feeds.map(feed => canonicalFeedUrl(feed.url))), [library.feeds])
  const sources = catalog?.[shelf]?.sources ?? []
  const matches = useMemo(() => filterSources(sources, query, tag), [sources, query, tag])
  const tags = useMemo(() => (shelf === 'blogs' ? topTags(sources) : []), [shelf, sources])

  const subscribe = async (source: DiscoverySource): Promise<void> => {
    const group = source.category || ''
    const result = await store.addFeed(source.url, group ? store.addGroup(group) : '')
    useUi.getState().toast(result.ok
      ? { title: t('rss.subscribed'), tone: 'success' }
      : { title: result.error ?? t('rss.error.unreachable'), tone: 'danger' })
  }

  if (failed) return <p className="p-8 text-center text-[12.5px] text-[var(--danger)]">{t('rss.discover.failed')}</p>
  if (!catalog) return <p className="p-8 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('rss.loading')}</p>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <Segmented
          size="sm"
          value={shelf}
          onChange={value => setShelf(value as ShelfName)}
          options={[
            { value: 'featured', label: t('rss.discover.featured') },
            { value: 'blogs', label: t('rss.discover.blogs') },
            { value: 'news', label: t('rss.discover.news') },
          ]}
        />
        <div className="min-w-[180px] flex-1">
          <FilterInput value={query} onChange={setQuery} query={compileQuery(query)} label={t('rss.discover.search')} size="sidebar" />
        </div>
        {tags.length > 0 && (
          <select
            value={tag}
            onChange={event => setTag(event.target.value)}
            aria-label={t('rss.discover.tag')}
            className="h-8 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-base)] px-2 text-[12px] text-[var(--text-primary)]"
          >
            <option value="">{t('rss.discover.tag_any')}</option>
            {tags.map(entry => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        )}
        <span className="ml-auto text-[11px] text-[var(--text-quaternary)]">{t('rss.discover.results', { n: matches.length })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {matches.slice(0, limit).map(source => (
          <div key={source.id} className="flex items-center gap-2 rounded-[var(--r-md)] px-1.5 py-1.5 hover:bg-[var(--bg-hover)]">
            <div className="min-w-0 flex-1">
              <div className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">{source.name}</div>
              <div className="min-w-0 truncate text-[10.5px] text-[var(--text-quaternary)]">
                {[source.category, source.tags.join(' / '), host(source.url)].filter(Boolean).join(' · ')}
              </div>
            </div>
            {subscribed.has(canonicalFeedUrl(source.url))
              ? <span className="shrink-0 text-[11px] text-[var(--text-quaternary)]">{t('rss.subscribed')}</span>
              : <Button size="sm" icon={<Plus size={12} />} onClick={() => void subscribe(source)}>{t('rss.subscribe')}</Button>}
          </div>
        ))}
        {matches.length > limit && (
          <div className="py-2">
            <Button size="sm" block onClick={() => setLimit(value => value + 60)}>{t('rss.discover.show_more')}</Button>
          </div>
        )}
      </div>
      <p className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]">
        {t('rss.discover.provenance', { source: catalog[shelf].source, revision: catalog[shelf].revision })}
      </p>
    </div>
  )
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  }
  catch {
    return url
  }
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'timeout':
      return t('rss.error.timeout')
    case 'too-large':
      return t('rss.error.too_large')
    case 'not-a-feed':
      return t('rss.error.not_a_feed')
    case 'blocked':
      return t('rss.error.blocked')
    case 'http':
      return t('rss.error.http_status')
    default:
      return t('rss.error.unreachable')
  }
}
