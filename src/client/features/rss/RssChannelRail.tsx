/**
 * The channel rail: where the reader is, and the whole subscription library that can be reached.
 *
 * It used to be a list of buttons and nothing else, on the theory that every other question about a
 * subscription belongs to the management dialog. That theory cost the reader two round trips for
 * every ordinary act — move a feed, rename a folder, pause a source — and the dialog has no more
 * room for a folder's colour than the rail does. So the rail now carries the three things a reader
 * does with a subscription without leaving the list of them: a right-click, a drag onto a folder,
 * and a name that can be typed in place.
 *
 * Folders nest, and the nesting is the note folders' own: `RssGroup` is shaped like `Folder` so
 * `buildFolderTree` can arrange both trees, and the colour and icon pickers are the same panels the
 * sidebar uses. Two implementations of "which folder can this not go into" is how a subscription
 * ends up inside its own descendant.
 *
 * An unread badge only appears for a feed this device has actually read from. A zero would be a
 * claim about the world the rail has no way to make.
 */
import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  ChevronRight,
  CircleDot,
  Clock,
  FolderClosed,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Hash,
  Inbox,
  Layers,
  MailOpen,
  Pencil,
  Palette,
  Pause,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Rss,
  Smile,
  Star,
  Trash2,
  Unlink,
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { confirm, prompt, Tooltip, type MenuItem } from '../../components/overlay'
import { TREE_INDENT_STEP, treeIndent, treeItemProps, useTreeKeyboard } from '../../lib/tree'
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus'
import { buildFolderTree, type FolderNode } from '../../store/notes'
import { leftDropTarget } from '../../lib/note-drag'
import { tagKey } from '@shared/markdown-utils'
import { channelKey, feedShelfOrder, tagCounts, unreadCounts, type RssChannel } from '@shared/rss/reading'
import { ExternalLink } from 'lucide-react'
import { RSS_LIMITS, safeHttpUrl, type RssEntry, type RssFeed, type RssGroup, type RssLibrary } from '@shared/rss/model'
import { useSession } from '../../store/session'
import { api } from '../../lib/api'
import { displayImageUrl } from './sanitize'
import { copyFeedUrlItem, moveToFolderItem, RssContextMenu, tagsItem } from './rssMenus'
import { useLongPress } from '../workspace/context-menu/use-long-press'
import { useNotes } from '../../store/notes'
import { vaultChannels } from './vault'
import { FeedMark, feedIconUrl } from './FeedMark'
import { useRss } from './store'
import { feedCacheLine } from './cacheLine'

export const RSS_FEED_DRAG = 'application/x-inkstone-rss-feed'
export const RSS_GROUP_DRAG = 'application/x-inkstone-rss-group'

/**
 * How much deeper a feed row sits than the folder holding it.
 *
 * A row's own level already comes from `treeIndent`, and a feed is drawn one level below its
 * folder. This is the deliberate extra step on top of that: a folder row spends its first
 * `size-4` on the collapse chevron and a feed row spends it on the favicon, so a feed lined up at
 * plain `treeIndent` would read as its folder's sibling rather than its content.
 */
const FEED_INDENT_STEP = TREE_INDENT_STEP

type MenuTarget
  = | { kind: 'feed', id: string }
    | { kind: 'group', id: string }
    | { kind: 'tag', id: string }
    | { kind: 'blank' }

interface MenuState {
  point: { x: number, y: number }
  target: MenuTarget
}

export function RssChannelRail({ onPick }: { onPick?: () => void }) {
  const state = useRss()
  const library = state.library
  const counts = unreadCounts({ library, articles: state.articles })
  const active = channelKey(state.channel)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const go = (next: RssChannel): void => {
    void state.open(next)
    onPick?.()
  }

  const feedsByGroup = new Map<string, number>()
  for (const feed of library.feeds) feedsByGroup.set(feed.groupId, (feedsByGroup.get(feed.groupId) ?? 0) + 1)
  const tree = buildFolderTree(library.groups, feedsByGroup)
  const shelfFeeds = (groupId: string): RssFeed[] =>
    library.feeds.filter(feed => feed.groupId === groupId).sort(feedShelfOrder)
  // Root folders and unfiled feeds are one sibling set: the tree reads them as one level, so their
  // `aria-setsize`/`aria-posinset` have to count both.
  const rootFeeds = shelfFeeds('')
  const rootSetSize = tree.length + rootFeeds.length
  const tagDisplay = new Map<string, string>()
  for (const feed of library.feeds) {
    for (const tag of feed.tags) if (!tagDisplay.has(tagKey(tag))) tagDisplay.set(tagKey(tag), tag)
  }
  const tags = [...tagCounts(library).entries()].sort((a, b) => a[0].localeCompare(b[0]))
  // The reader's own notes, as channels. Derived from the notebook's store rather than synced: the
  // folder tree is the same one the sidebar shows, and a second copy of it would drift.
  const noteFolders = useNotes(state => state.folders)
  const noteList = useNotes(state => state.notes)
  const vault = useMemo(() => vaultChannels(noteFolders, Object.values(noteList)), [noteFolders, noteList])
  const hiddenCount = library.hiddenIds.length

  // One gesture for the whole rail: a phone has no right button, and every row carries the target it
  // is about in `data-menu-target`, so the held press is read from the row under the finger.
  const { handlers: longPress, justLongPressed } = useLongPress((point, node) => {
    const raw = node.closest('[data-menu-target]')?.getAttribute('data-menu-target') ?? ''
    const separator = raw.indexOf(':')
    if (separator < 0) return
    const kind = raw.slice(0, separator)
    const id = raw.slice(separator + 1)
    if (kind === 'feed' || kind === 'group' || kind === 'tag') setMenu({ point, target: { kind, id } })
  })

  const openMenu = (event: React.MouseEvent, target: MenuTarget): void => {
    // A held finger already opened this menu; the contextmenu event a desktop browser sends for the
    // same gesture must not open it a second time.
    if (justLongPressed()) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({ point: { x: event.clientX, y: event.clientY }, target })
  }

  const items = menu ? buildMenuItems(menu.target, state, library) : []

  return (
    <nav
      aria-label={t('rss.subscriptions')}
      onContextMenu={event => openMenu(event, { kind: 'blank' })}
      {...longPress}
      className="flex h-full w-full min-w-0 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] lg:w-56"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <Row label={t('rss.channel_all')} icon={Layers} count={counts.total} active={active === 'all'} onSelect={() => go({ kind: 'all' })} />
        <Row label={t('rss.channel_unread')} icon={MailOpen} count={counts.total} active={active === 'unread'} onSelect={() => go({ kind: 'unread' })} />
        <Row label={t('rss.channel_starred')} icon={Star} count={library.favorites.length} active={active === 'starred'} onSelect={() => go({ kind: 'starred' })} />
        <Row label={t('rss.channel_later')} icon={Bookmark} count={library.readLater.length} active={active === 'later'} onSelect={() => go({ kind: 'later' })} />
        <Row label={t('rss.channel_recent')} icon={Clock} count={Object.keys(library.opened).length} active={active === 'recent'} onSelect={() => go({ kind: 'recent' })} />
        {hiddenCount > 0 && (
          <Row label={t('rss.channel_hidden')} icon={FolderMinus} count={hiddenCount} active={active === 'hidden'} onSelect={() => go({ kind: 'all' })} onContextMenu={event => openMenu(event, { kind: 'blank' })} />
        )}

        <div className="mt-4 mb-1 flex items-center gap-1 px-2">
          <span className="min-w-0 flex-1 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)] uppercase">
            {t('rss.subscriptions')}
          </span>
          <Tooltip label={t('rss.new_folder')}>
            <button
              type="button"
              aria-label={t('rss.new_folder')}
              className="grid size-5 place-items-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => void newFolder(state, null)}
            >
              <FolderPlus size={13} />
            </button>
          </Tooltip>
        </div>

        {/* The shelf is a tree, not a list of buttons: folders nest feeds, and a screen reader has
            to be told which level each row sits at and which branch it is inside. Everything under
            this heading is one tree, so `useTreeKeyboard` walks the unfiled feeds and the folders
            with the same arrow keys. */}
        <div role="tree" aria-label={t('rss.subscriptions')}>
          {tree.map((node, index) => (
            <FolderBranch
              key={node.id}
              node={node}
              depth={0}
              setSize={rootSetSize}
              posInSet={index + 1}
              counts={counts}
              articles={state.articles}
              active={active}
              dropTarget={dropTarget}
              go={go}
              openMenu={openMenu}
              setDropTarget={setDropTarget}
              shelfFeeds={shelfFeeds}
            />
          ))}
          {rootFeeds.map((feed, index) => (
            <FeedRow
              key={feed.id}
              feed={feed}
              unread={counts.feeds.get(feed.id) ?? 0}
              loaded={!!state.articles[feed.id]}
              active={active === `feed:${feed.id}`}
              go={go}
              openMenu={openMenu}
              setDropTarget={setDropTarget}
              dropTarget={dropTarget}
              depth={0}
              setSize={rootSetSize}
              posInSet={tree.length + index + 1}
            />
          ))}
        </div>

        {vault.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)] uppercase">
              {t('rss.vault_channels')}
            </div>
            {vault.map(folder => (
              <Row
                key={folder.id}
                label={folder.name}
                icon={FolderOpen}
                count={folder.count}
                active={active === `vault:${folder.id}`}
                onSelect={() => go({ kind: 'vault', folderId: folder.id })}
              />
            ))}
          </>
        )}

        {tags.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-2 text-[length:var(--text-10-5)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)] uppercase">
              {t('rss.tags')}
            </div>
            {tags.map(([tag, total]) => (
              <Row
                key={tag}
                label={tagDisplay.get(tag) ?? tag}
                icon={Hash}
                count={total}
                active={active === `tag:${tag}`}
                onSelect={() => go({ kind: 'tag', tag })}
                menuTarget={`tag:${tag}`}
                onContextMenu={event => openMenu(event, { kind: 'tag', id: tag })}
              />
            ))}
          </>
        )}
      </div>
      <RssContextMenu point={menu?.point ?? null} items={items} label={t('rss.menu')} onClose={() => setMenu(null)} />
    </nav>
  )
}

async function newFolder(state: ReturnType<typeof useRss.getState>, parentId: string | null): Promise<void> {
  const name = await prompt({ title: parentId ? t('rss.new_subfolder') : t('rss.new_folder'), placeholder: t('rss.folder_placeholder') })
  if (name?.trim()) state.addGroup(name.trim(), parentId)
}

function FolderBranch({ node, depth, setSize, posInSet, shelfFeeds, counts, articles, active, dropTarget, go, openMenu, setDropTarget }: {
  node: FolderNode
  depth: number
  setSize: number
  posInSet: number
  shelfFeeds: (groupId: string) => RssFeed[]
  counts: ReturnType<typeof unreadCounts>
  articles: Record<string, RssEntry[]>
  active: string
  dropTarget: string | null
  go: (channel: RssChannel) => void
  openMenu: (event: React.MouseEvent, target: MenuTarget) => void
  setDropTarget: (id: string | null) => void
}) {
  const toggle = useRss(state => state.toggleGroupCollapsed)
  // FolderNode is a note Folder, and a note folder has no collapse state of its own: the rail
  // keeps the open/closed answer in the subscription library, where it is saved.
  const collapsed = useRss(state => state.library.groups.some(group => group.id === node.id && group.collapsed))
  const feeds = shelfFeeds(node.id)
  const key = `group:${node.id}`
  const isDrop = dropTarget === key
  const onKeyDown = useTreeKeyboard()
  return (
    <div
      className="mb-0.5"
      {...treeItemProps({ level: depth + 1, expanded: !collapsed, selected: active === key, setSize, posInSet })}
    >
      <div
        draggable
        data-menu-target={`group:${node.id}`}
        onContextMenu={event => openMenu(event, { kind: 'group', id: node.id })}
        onDragStart={event => {
          event.dataTransfer.setData(RSS_GROUP_DRAG, node.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes(RSS_FEED_DRAG) && !event.dataTransfer.types.includes(RSS_GROUP_DRAG)) return
          event.preventDefault()
          setDropTarget(key)
        }}
        onDragLeave={event => {
          if (leftDropTarget(event)) setDropTarget(null)
        }}
        onDrop={event => {
          event.preventDefault()
          setDropTarget(null)
          dropOnGroup(event, node.id)
        }}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[var(--r-md)] pr-1.5 text-left text-[length:var(--text-12-5)]',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          active === key
            ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          isDrop && 'ring-1 ring-[var(--accent)]',
        )}
        style={{ paddingLeft: treeIndent(depth) }}
      >
        <button
          type="button"
          data-tree-toggle
          aria-expanded={!collapsed}
          aria-controls={`${node.id}-children`}
          aria-label={`${collapsed ? t('rss.expand') : t('rss.collapse')} ${node.name}`}
          onClick={() => toggle(node.id)}
          className="grid size-4 shrink-0 place-items-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronRight size={12} className={cn('transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]', !collapsed && 'rotate-90')} />
        </button>
        <button
          type="button"
          data-tree-row
          onKeyDown={onKeyDown}
          aria-current={active === key ? 'page' : undefined}
          onClick={() => go({ kind: 'group', groupId: node.id })}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          {node.icon
            ? <span aria-hidden="true" className="shrink-0 text-[length:var(--text-13)] leading-none" style={{ color: node.color ?? undefined }}>{node.icon}</span>
            : node.color
              ? <CircleDot size={13} className="shrink-0" style={{ color: node.color }} aria-hidden="true" />
              : (collapsed ? <FolderClosed size={13} className="shrink-0 opacity-70" /> : <FolderOpen size={13} className="shrink-0 opacity-70" />)}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {(counts.groups.get(node.id) ?? 0) > 0 && (
            <span className="shrink-0 text-[length:var(--text-10-5)] font-medium tabular-nums text-[var(--text-quaternary)]">
              {(counts.groups.get(node.id) ?? 0) > 99 ? '99+' : counts.groups.get(node.id)}
            </span>
          )}
        </button>
      </div>
      {/* The collapse toggle names the region it opens, so that region is an element that exists
          while it is closed too — a fragment that mounts and unmounts leaves `aria-controls`
          pointing at nothing. Each row indents itself, so the wrapper changes no geometry.
          `role="group"` is only stated while the branch is open: an empty group would tell a screen
          reader the folder has children it cannot hear. */}
      <div id={`${node.id}-children`} role={collapsed ? undefined : 'group'}>
        {!collapsed && (
          <>
            {node.children.map((child, index) => (
              <FolderBranch
                key={child.id}
                node={child}
                depth={depth + 1}
                setSize={node.children.length + feeds.length}
                posInSet={index + 1}
                shelfFeeds={shelfFeeds}
                counts={counts}
                articles={articles}
                active={active}
                dropTarget={dropTarget}
                go={go}
                openMenu={openMenu}
                setDropTarget={setDropTarget}
              />
            ))}
            {feeds.map((feed, index) => (
              <FeedRow
                key={feed.id}
                feed={feed}
                unread={counts.feeds.get(feed.id) ?? 0}
                loaded={!!articles[feed.id]}
                active={active === `feed:${feed.id}`}
                go={go}
                openMenu={openMenu}
                setDropTarget={setDropTarget}
                dropTarget={dropTarget}
                depth={depth + 1}
                setSize={node.children.length + feeds.length}
                posInSet={node.children.length + index + 1}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}


function FeedRow({ feed, unread, loaded, active, depth, setSize, posInSet, dropTarget, go, openMenu, setDropTarget }: {
  feed: RssFeed
  unread: number
  loaded: boolean
  active: boolean
  depth: number
  setSize: number
  posInSet: number
  dropTarget: string | null
  go: (channel: RssChannel) => void
  openMenu: (event: React.MouseEvent, target: MenuTarget) => void
  setDropTarget: (id: string | null) => void
}) {
  const settings = useSession(session => session.settings.rss)
  const cache = useRss(state => state.cache)
  const onKeyDown = useTreeKeyboard()
  const src = displayImageUrl(feed.imageUrl || feedIconUrl(feed), {
    images: settings.images,
    relay: url => api.rss.relayUrl(url),
  })
  const isDrop = dropTarget === `feed:${feed.id}`
  const row = (
    <button
      type="button"
      draggable
      data-tree-row
      onKeyDown={onKeyDown}
      {...treeItemProps({ level: depth + 1, selected: active, setSize, posInSet })}
      aria-current={active ? 'page' : undefined}
      onClick={() => go({ kind: 'feed', feedId: feed.id })}
      data-menu-target={`feed:${feed.id}`}
      onContextMenu={event => openMenu(event, { kind: 'feed', id: feed.id })}
      onDragStart={event => {
        event.dataTransfer.setData(RSS_FEED_DRAG, feed.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes(RSS_FEED_DRAG)) return
        event.preventDefault()
        setDropTarget(`feed:${feed.id}`)
      }}
      onDragLeave={event => {
        if (leftDropTarget(event)) setDropTarget(null)
      }}
      onDrop={event => {
        event.preventDefault()
        setDropTarget(null)
        dropOnFeed(event, feed)
      }}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[var(--r-md)] pr-1.5 text-left text-[length:var(--text-12-5)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        feed.paused && 'opacity-60',
        isDrop && 'ring-1 ring-[var(--accent)]',
      )}
      style={{ paddingLeft: treeIndent(depth) + FEED_INDENT_STEP }}
    >
      <FeedMark src={src} title={feed.title} size={16} />
      {feed.pinned && <Pin size={10} className="shrink-0 opacity-55" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{feed.title}</span>
      {feed.tags.length > 0 && <Hash size={10} className="shrink-0 opacity-45" aria-hidden="true" />}
      {loaded && unread > 0 && (
        <span className="shrink-0 text-[length:var(--text-10-5)] font-medium tabular-nums text-[var(--text-quaternary)]">{unread > 99 ? '99+' : unread}</span>
      )}
    </button>
  )
  // The row is one line tall and the count has nowhere to go but here: what this device holds for
  // this subscription, and the address or the failure a reader maintaining the list is looking for.
  const hint = [feedCacheLine(cache[feed.id]), feed.error || feed.url].filter(Boolean).join(' · ')
  return hint ? <Tooltip label={hint} side="right">{row}</Tooltip> : row
}

/** Drop a feed onto another feed: it joins that shelf and takes its place in the order. */
function dropOnFeed(event: React.DragEvent, target: RssFeed): void {
  const moving = event.dataTransfer.getData(RSS_FEED_DRAG)
  if (!moving || moving === target.id) return
  const library = useRss.getState().library
  const shelf = library.feeds
    .filter(feed => feed.groupId === target.groupId && feed.id !== moving)
    .sort(feedShelfOrder)
  useRss.getState().moveFeedTo(moving, target.groupId, shelf.findIndex(feed => feed.id === target.id))
}

/** Drop a dragged feed or folder onto a folder row. */
function dropOnGroup(event: React.DragEvent, groupId: string): void {
  const state = useRss.getState()
  const feedId = event.dataTransfer.getData(RSS_FEED_DRAG)
  if (feedId) {
    state.moveFeedTo(feedId, groupId)
    return
  }
  const moved = event.dataTransfer.getData(RSS_GROUP_DRAG)
  if (moved && moved !== groupId) state.moveGroupTo(moved, groupId)
}

function Row({ icon: Icon, label, count, active, onSelect, trailing, hint, muted, showCount = true, menuTarget, onContextMenu }: {
  icon?: typeof Rss
  label: string
  count: number
  active: boolean
  onSelect: () => void
  trailing?: React.ReactNode
  hint?: string
  muted?: boolean
  showCount?: boolean
  menuTarget?: string
  onContextMenu?: (event: React.MouseEvent) => void
}) {
  const row = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      data-menu-target={menuTarget}
      aria-current={active ? 'page' : undefined}
      // A flat row is a depth-0 row: the same `treeIndent` the folder rows use, so the shelf's
      // shortcuts line up with the folders below them instead of a Tailwind step of their own.
      style={{ paddingLeft: treeIndent(0) }}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 rounded-[var(--r-md)] pr-1.5 text-left text-[length:var(--text-12-5)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        muted && 'opacity-60',
      )}
    >
      {Icon && <Icon size={13} className="shrink-0 opacity-70" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {showCount && count > 0 && (
        <span className="shrink-0 text-[length:var(--text-10-5)] font-medium tabular-nums text-[var(--text-quaternary)]">{count > 99 ? '99+' : count}</span>
      )}
      {trailing}
    </button>
  )
  return hint ? <Tooltip label={hint} side="right">{row}</Tooltip> : row
}


/** The rail's whole right-click surface: a feed, a folder, a tag, or the empty space below them. */
function buildMenuItems(
  target: MenuTarget,
  state: ReturnType<typeof useRss.getState>,
  library: RssLibrary,
): MenuItem[] {
  if (target.kind === 'feed') {
    const feed = library.feeds.find(item => item.id === target.id)
    if (!feed) return []
    const siblings = library.feeds
      .filter(item => item.groupId === feed.groupId)
      .sort(feedShelfOrder)
    const at = siblings.findIndex(item => item.id === feed.id)
    return [
      {
        id: 'refresh',
        label: t('rss.refresh_feed'),
        icon: <RefreshCw size={13} />,
        onSelect: () => void state.refresh([feed.id], { force: true }),
      },
      {
        id: 'open',
        label: t('rss.open_original'),
        icon: <ExternalLink size={13} />,
        // The address came out of somebody else's document, so it is asked again before a window is
        // opened with it — the same rule the article menu follows.
        onSelect: () => {
          const target = safeHttpUrl(feed.siteUrl || feed.url)
          if (target) window.open(target.href, '_blank', 'noopener,noreferrer')
        },
      },
      copyFeedUrlItem(feed),
      {
        id: 'rename',
        label: t('rss.rename_feed'),
        icon: <Pencil size={13} />,
        separatorBefore: true,
        onSelect: () => {
          void prompt({ title: t('rss.rename_feed'), defaultValue: feed.title }).then(value => {
            if (value?.trim()) state.renameFeed(feed.id, value.trim())
          })
        },
      },
      moveToFolderItem(library, {
        currentGroupId: feed.groupId,
        onPick: groupId => state.moveFeedTo(feed.id, groupId),
      }),
      tagsItem(feed, library, tag => {
        const worn = new Set(feed.tags.map(tagKey))
        const key = tagKey(tag)
        const next = worn.has(key)
          ? feed.tags.filter(item => tagKey(item) !== key)
          : [...feed.tags, tag]
        state.setFeedTags(feed.id, next)
      }),
      {
        id: 'pin',
        label: feed.pinned ? t('rss.unpin_feed') : t('rss.pin_feed'),
        icon: feed.pinned ? <PinOff size={13} /> : <Pin size={13} />,
        onSelect: () => state.setPinned(feed.id, !feed.pinned),
      },
      {
        id: 'pause',
        label: feed.paused ? t('rss.resume_feed') : t('rss.pause_feed'),
        icon: feed.paused ? <Play size={13} /> : <Pause size={13} />,
        separatorBefore: true,
        onSelect: () => state.setPaused(feed.id, !feed.paused),
      },
      {
        id: 'up',
        label: t('rss.move_up'),
        icon: <ArrowUp size={13} />,
        disabled: at <= 0,
        onSelect: () => state.moveFeedTo(feed.id, feed.groupId, at - 1),
      },
      {
        id: 'down',
        label: t('rss.move_down'),
        icon: <ArrowDown size={13} />,
        disabled: at < 0 || at >= siblings.length - 1,
        onSelect: () => state.moveFeedTo(feed.id, feed.groupId, at + 1),
      },
      {
        id: 'unsubscribe',
        label: t('rss.unsubscribe'),
        icon: <Unlink size={13} />,
        tone: 'danger',
        separatorBefore: true,
        onSelect: () => {
          void confirm({
            title: t('rss.unsubscribe'),
            description: t('rss.unsubscribe_confirm', { name: feed.title }),
            tone: 'danger',
          }).then(yes => {
            if (yes) state.removeFeed(feed.id)
          })
        },
      },
    ]
  }

  if (target.kind === 'group') {
    const group = library.groups.find(item => item.id === target.id)
    if (!group) return []
    const siblings = library.groups
      .filter(item => (item.parentId ?? '') === (group.parentId ?? ''))
      .sort((a, b) => a.position - b.position)
    const at = siblings.findIndex(item => item.id === group.id)
    return [
      {
        id: 'new-child',
        label: t('rss.new_subfolder'),
        icon: <FolderPlus size={13} />,
        disabled: siblings.length > 0 && depthOf(library, group.id) + 1 >= RSS_LIMITS.groupDepthMax,
        onSelect: () => void newFolder(state, group.id),
      },
      {
        id: 'rename',
        label: t('rss.rename_folder'),
        icon: <Pencil size={13} />,
        onSelect: () => {
          void prompt({ title: t('rss.rename_folder'), defaultValue: group.name }).then(value => {
            if (value?.trim()) state.renameGroup(group.id, value.trim())
          })
        },
      },
      {
        id: 'color',
        label: t('folders.color'),
        icon: <Palette size={13} />,
        separatorBefore: true,
        submenu: ({ closeMenu }) => (
          <FolderColorMenu
            color={group.color}
            onSelectColor={color => {
              state.setGroupAppearance(group.id, { color })
              closeMenu()
            }}
          />
        ),
      },
      {
        id: 'icon',
        label: t('folders.icon'),
        icon: <Smile size={13} />,
        submenu: ({ closeMenu }) => (
          <FolderIconMenu
            icon={group.icon}
            onSelectIcon={icon => {
              state.setGroupAppearance(group.id, { icon })
              closeMenu()
            }}
          />
        ),
      },
      moveToFolderItem(library, {
        movingGroupId: group.id,
        currentGroupId: group.parentId ?? '',
        onPick: parentId => state.moveGroupTo(group.id, parentId || null),
      }),
      {
        id: 'up',
        label: t('rss.move_up'),
        icon: <ArrowUp size={13} />,
        disabled: at <= 0,
        onSelect: () => state.moveGroupTo(group.id, group.parentId, at - 1),
      },
      {
        id: 'down',
        label: t('rss.move_down'),
        icon: <ArrowDown size={13} />,
        disabled: at < 0 || at >= siblings.length - 1,
        onSelect: () => state.moveGroupTo(group.id, group.parentId, at + 1),
      },
      {
        id: 'delete',
        label: t('rss.delete_folder'),
        icon: <Trash2 size={13} />,
        tone: 'danger',
        separatorBefore: true,
        onSelect: () => {
          const inside = library.feeds.filter(feed => feed.groupId === group.id).length
          void confirm({
            title: t('rss.delete_folder'),
            description: t('rss.delete_folder_confirm', { n: inside }),
            tone: 'danger',
          }).then(yes => {
            if (yes) state.removeGroup(group.id)
          })
        },
      },
    ]
  }

  if (target.kind === 'tag') {
    const tag = target.id
    const wearing = library.feeds.filter(feed => feed.tags.some(item => tagKey(item) === tagKey(tag)))
    return [
      {
        id: 'open',
        label: t('rss.channel_tag'),
        icon: <Hash size={13} />,
        onSelect: () => void state.open({ kind: 'tag', tag }),
      },
      {
        id: 'rename',
        label: t('rss.rename_tag'),
        icon: <Pencil size={13} />,
        separatorBefore: true,
        onSelect: () => {
          void prompt({ title: t('rss.rename_tag'), defaultValue: tag }).then(value => {
            const next = value?.trim()
            if (!next) return
            for (const feed of wearing) {
              state.setFeedTags(feed.id, feed.tags.map(item => (tagKey(item) === tagKey(tag) ? next : item)))
            }
          })
        },
      },
      {
        id: 'remove',
        label: t('rss.delete_tag'),
        icon: <Trash2 size={13} />,
        tone: 'danger',
        onSelect: () => {
          void confirm({
            title: t('rss.delete_tag'),
            description: t('rss.delete_tag_confirm', { n: wearing.length }),
            tone: 'danger',
          }).then(yes => {
            if (!yes) return
            for (const feed of wearing) {
              state.setFeedTags(feed.id, feed.tags.filter(item => tagKey(item) !== tagKey(tag)))
            }
          })
        },
      },
    ]
  }

  const items: MenuItem[] = [
    { id: 'new-folder', label: t('rss.new_folder'), icon: <FolderPlus size={13} />, onSelect: () => void newFolder(state, null) },
    {
      id: 'refresh-all',
      label: t('rss.refresh_all'),
      icon: <RefreshCw size={13} />,
      disabled: library.feeds.length === 0,
      onSelect: () => void state.refresh(undefined, { force: true }),
    },
  ]
  if (library.hiddenIds.length > 0) {
    items.push({
      id: 'unhide-all',
      label: t('rss.unhide_all'),
      icon: <Inbox size={13} />,
      separatorBefore: true,
      onSelect: () => state.hideEntries(library.hiddenIds, false),
    })
  }
  if (library.groups.some(group => !group.collapsed)) {
    items.push({
      id: 'collapse-all',
      label: t('rss.collapse_all'),
      icon: <FolderClosed size={13} />,
      separatorBefore: true,
      onSelect: () => {
        for (const group of library.groups) if (!group.collapsed) state.toggleGroupCollapsed(group.id)
      },
    })
  }
  return items
}

function depthOf(library: RssLibrary, groupId: string): number {
  const byId = new Map(library.groups.map(group => [group.id, group]))
  let depth = 0
  let cursor: RssGroup | undefined = byId.get(groupId)
  const seen = new Set<string>()
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    cursor = byId.get(cursor.parentId)
    depth++
  }
  return depth
}
