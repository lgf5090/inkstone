/**
 * The pieces every RSS right-click menu is built from.
 *
 * Three surfaces — the channel rail, the article list and the reader — each own their own rows, so
 * each builds its own item list. What they must not each own is the *shape* of a choice: two
 * hand-written copies of "which folder could this go into" drift into two different answers about
 * which folder a feed cannot be moved into, and the reader finds out by losing a subscription into
 * its own descendant.
 */
import type { ReactNode } from 'react'
import { BookOpen, Bookmark, CalendarPlus, CheckCheck, ExternalLink, EyeOff, FolderInput, Hash, Link2, NotebookPen, Plus, Star } from 'lucide-react'
import { t } from '../../lib/i18n'
import { useUi, type ToastInput } from '../../store/ui'
import { appendToDailyNote, openSavedNote, savedNoteId, saveArticleAsNote } from './notes'
import { useRss } from './store'
import { Menu, prompt, submenuFor, type MenuItem } from '../../components/overlay'
import { RSS_LIMITS, safeHttpUrl, type RssEntry, type RssFeed, type RssGroup, type RssLibrary } from '@shared/rss/model'
import { descendantGroupIds, findFeed } from '@shared/rss/reading'
import { tagKey } from '@shared/markdown-utils'

/** The folders a feed or another folder may be dropped into, as an indented list. */
export function folderChoices(
  library: RssLibrary,
  options: { movingGroupId?: string, currentGroupId: string, onPick: (groupId: string) => void },
): MenuItem[] {
  const blocked = options.movingGroupId ? descendantGroupIds(library.groups, options.movingGroupId) : new Set<string>()
  if (options.movingGroupId) blocked.add(options.movingGroupId)
  const depthOf = (group: RssGroup): number => {
    let depth = 0
    let cursor: string | null = group.parentId
    const seen = new Set<string>([group.id])
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const parent = library.groups.find(item => item.id === cursor)
      if (!parent) break
      cursor = parent.parentId
      depth++
    }
    return depth
  }
  const items: MenuItem[] = [{
    id: 'ungrouped',
    label: t('rss.ungrouped'),
    checked: options.currentGroupId === '',
    onSelect: () => options.onPick(''),
  }]
  for (const group of [...library.groups].sort((a, b) => a.position - b.position)) {
    if (blocked.has(group.id)) continue
    const indent = ' '.repeat(depthOf(group) * 2)
    items.push({
      id: group.id,
      label: `${indent}${group.name}`,
      checked: options.currentGroupId === group.id,
      onSelect: () => options.onPick(group.id),
    })
  }
  return items
}

/** Every tag the library already carries, plus the row that types a new one. */
export function tagChoices(
  library: RssLibrary,
  feed: RssFeed,
  onToggle: (tag: string) => void,
): MenuItem[] {
  const worn = new Set(feed.tags.map(tagKey))
  const seen = new Map<string, string>()
  for (const item of library.feeds) {
    for (const tag of item.tags) {
      const key = tagKey(tag)
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  const items: MenuItem[] = [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, 40)
    .map(([key, name]) => ({
      id: `tag:${key}`,
      label: name,
      checked: worn.has(key),
      onSelect: () => onToggle(name),
    }))
  items.push({
    id: 'tag-new',
    label: t('rss.tag_new'),
    icon: <Plus size={13} />,
    separatorBefore: items.length > 0,
    onSelect: () => {
      void prompt({ title: t('rss.tag_new'), placeholder: t('rss.tag_placeholder') }).then((value) => {
        if (value) onToggle(value.trim())
      })
    },
  })
  return items
}

/** A menu opened at a pointer position. The rail, the list and the reader all anchor this way. */
export function RssContextMenu({ point, onClose, items, label }: {
  point: { x: number, y: number } | null
  onClose: () => void
  items: MenuItem[]
  label: string
}): ReactNode {
  if (!point) return null
  return (
    <Menu
      anchor={point}
      open
      onClose={onClose}
      items={items}
      width={216}
      label={label}
      searchable
      searchPlaceholder={t('rss.menu_search')}
    />
  )
}

/** The "move to folder" row, built once because the rail and the list both need it. */
export function moveToFolderItem(
  library: RssLibrary,
  options: { movingGroupId?: string, currentGroupId: string, onPick: (groupId: string) => void },
): MenuItem {
  const choices = folderChoices(library, options)
  return {
    id: 'move-folder',
    label: t('rss.move_to_folder'),
    icon: <FolderInput size={13} />,
    submenu: submenuFor(choices, 190),
    subItems: choices,
  }
}

/** The tag row, same reason. */
export function tagsItem(feed: RssFeed, library: RssLibrary, onToggle: (tag: string) => void): MenuItem {
  const choices = tagChoices(library, feed, onToggle)
  return {
    id: 'tags',
    label: t('rss.tags'),
    icon: <Hash size={13} />,
    separatorBefore: true,
    submenu: submenuFor(choices, 200),
    subItems: choices,
  }
}

export const RSS_TAG_LIMIT = RSS_LIMITS.tagsPerFeed

/**
 * The row that puts a subscription's own address on the clipboard.
 *
 * The rail and the subscription dialog both need it, and a reader who is moving a feed to another
 * app wants the address the subscription *is*, not the site it came from.
 */
export function copyFeedUrlItem(feed: RssFeed): MenuItem {
  return {
    id: 'copy-feed-url',
    label: t('rss.copy_feed_url'),
    icon: <Link2 size={13} />,
    onSelect: () => {
      void navigator.clipboard.writeText(feed.url).then(
        () => useUi.getState().toast({ title: t('rss.copied_feed_url'), tone: 'success' }),
        () => useUi.getState().toast({ title: t('rss.copy_failed'), tone: 'danger' }),
      )
    },
  }
}

/**
 * The menu on one article row.
 *
 * Every mark a reader can put on an article is here, because the row is where the article is
 * decided about — the reader pane's toolbar repeats the four common ones for the article that is
 * already open, and a fifth that needs a click on a row two screens away does not belong in a
 * toolbar. Hiding is the one that needs an undo: it is the only action whose effect outlives the
 * refresh that brought the article in.
 */
export function entryMenuItems(entry: RssEntry, library: RssLibrary, actions: { onOpen: () => void }): MenuItem[] {
  const state = useRss.getState()
  const read = state.library.readIds.includes(entry.id)
  const starred = state.library.favorites.includes(entry.id)
  const later = state.library.readLater.includes(entry.id)
  const feed = findFeed(library, entry.feedId)
  const noteId = savedNoteId(library, entry.id)
  const toast = (input: ToastInput): void => {
    useUi.getState().toast(input)
  }
  return [
    { id: 'open', label: t('rss.menu_open'), icon: <BookOpen size={13} />, onSelect: actions.onOpen },
    {
      id: 'original',
      label: t('rss.open_original'),
      icon: <ExternalLink size={13} />,
      disabled: !entry.link,
      // The address came from a cache this device wrote, so the scheme is checked again here
      // rather than trusted because the parser once asked for it.
      onSelect: () => {
        const target = safeHttpUrl(entry.link)
        if (target) window.open(target.href, '_blank', 'noopener,noreferrer')
      },
    },
    {
      id: 'copy',
      label: t('rss.copy_link'),
      icon: <Link2 size={13} />,
      disabled: !entry.link,
      onSelect: () => {
        void navigator.clipboard.writeText(entry.link).then(
          () => toast({ title: t('rss.copied'), tone: 'success' }),
          () => toast({ title: t('rss.copy_failed'), tone: 'danger' }),
        )
      },
    },
    { id: 'star', label: starred ? t('rss.unstar') : t('rss.star'), icon: <Star size={13} />, checked: starred, separatorBefore: true, onSelect: () => state.toggleFavorite(entry.id) },
    { id: 'later', label: later ? t('rss.not_later') : t('rss.read_later'), icon: <Bookmark size={13} />, checked: later, onSelect: () => state.toggleLater(entry.id) },
    { id: 'read', label: read ? t('rss.mark_unread') : t('rss.mark_read'), icon: <CheckCheck size={13} />, checked: !read, onSelect: () => state.markRead([entry.id], !read) },
    {
      id: 'daily',
      label: t('rss.add_to_daily'),
      icon: <CalendarPlus size={13} />,
      separatorBefore: true,
      onSelect: () => {
        void appendToDailyNote(entry, feed).then(outcome => {
          toast({
            title: outcome === 'added'
              ? t('rss.daily_added')
              : outcome === 'already'
                ? t('rss.daily_already')
                : t('rss.daily_missing'),
            tone: outcome === 'added' ? 'success' : 'danger',
          })
        })
      },
    },
    {
      id: 'note',
      label: t('rss.save_as_note'),
      icon: <NotebookPen size={13} />,
      onSelect: () => {
        void saveArticleAsNote(entry, feed).then(result => {
          toast(result.ok
            ? { title: t('rss.saved_note', { title: result.title ?? '' }), tone: 'success' }
            : { title: result.error ?? t('rss.save_failed'), tone: 'danger' })
        })
      },
    },
    ...(noteId
      ? [{
          id: 'open-note',
          label: t('rss.open_saved_note'),
          icon: <BookOpen size={13} />,
          onSelect: () => openSavedNote(noteId),
        } satisfies MenuItem]
      : []),
    {
      id: 'hide',
      label: t('rss.hide_article'),
      icon: <EyeOff size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => {
        state.hideEntries([entry.id], true)
        useUi.getState().toast({
          title: t('rss.hidden_toast', { n: 1 }),
          tone: 'default',
          action: { label: t('rss.undo'), run: () => state.hideEntries([entry.id], false) },
        })
      },
    },
  ]
}
