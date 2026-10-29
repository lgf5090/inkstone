import { useMemo, useState } from 'react'
import {
  ChevronsUpDown,
  Compass,
  Heart,
  ListVideo,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Settings2,
  Tags,
} from 'lucide-react'
import type { SortKey, TimeRange, YouTubeTag, YouTubeTagNode, YouTubeView } from '@shared/youtube/model'
import {
  buildTagTree,
  wouldCreateTagCycle,
  youtubeSearchParams,
  youtubeViewPath,
} from '@shared/youtube/model'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { confirm, Tooltip } from '../../../components/overlay'
import { FilterInput } from '../../../components/FilterInput'
import { compileQuery, queryMatches } from '../../../lib/query-match'
import { usePinyinVersion } from '../../../lib/pinyin'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { AddChannelDialog } from '../library/AddChannelDialog'
import { AddPlaylistDialog } from '../library/AddPlaylistDialog'
import { TagManagerModal } from '../tags/TagManagerModal'
import { SidebarLink } from './SidebarLink'
import { ChannelSection } from './ChannelSection'
import { PlaylistSection } from './PlaylistSection'
import { TagTree } from './TagTree'
import { droppedTagId } from '../tags/tagDrag'

export function YoutubeSidebar({
  activeView,
  sort,
  range,
  collapsed = false,
  hideHeader = false,
  onNavigate,
  onCollapse,
}: {
  activeView: YouTubeView
  sort: SortKey
  range: TimeRange
  collapsed?: boolean
  hideHeader?: boolean
  onNavigate?: () => void
  onCollapse?: () => void
}) {
  const library = useYoutubeStore((state) => state.library)
  const libraryStatus = useYoutubeStore((state) => state.libraryStatus)
  const libraryError = useYoutubeStore((state) => state.libraryError)
  const reloadLibrary = useYoutubeStore((state) => state.reloadLibrary)
  const expandedSections = useYoutubeStore((state) => state.expandedSections)
  const expandedTags = useYoutubeStore((state) => state.expandedTags)
  const toggleSection = useYoutubeStore((state) => state.toggleSection)
  const toggleTagExpanded = useYoutubeStore((state) => state.toggleTagExpanded)
  const preferredSort = useYoutubeStore((state) => state.sort)
  const preferredRange = useYoutubeStore((state) => state.range)
  const addTag = useYoutubeStore((state) => state.addTag)
  const editTag = useYoutubeStore((state) => state.editTag)
  const removeTag = useYoutubeStore((state) => state.removeTag)
  const reorderTags = useYoutubeStore((state) => state.reorderTags)
  const expandTag = useYoutubeStore((state) => state.expandTag)
  const setExpandedTags = useYoutubeStore((state) => state.setExpandedTags)
  const pinyinVersion = usePinyinVersion()

  const [addChannelOpen, setAddChannelOpen] = useState(false)
  const [addPlaylistOpen, setAddPlaylistOpen] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [tagFilterText, setTagFilterText] = useState('')
  const [renamingTagId, setRenamingTagId] = useState<string | null>(null)
  const [draftParent, setDraftParent] = useState<string | null | undefined>(undefined)
  const [draggingTagId, setDraggingTagId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const counts = useMemo(() => {
    let pinned = 0
    let favorites = 0
    for (const video of library.videos) {
      if (video.pinned) pinned++
      if (video.favorited) favorites++
    }
    return { all: library.videos.length, pinned, favorites }
  }, [library.videos])

  const tagCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const video of library.videos) {
      for (const tagId of video.tagIds) map.set(tagId, (map.get(tagId) ?? 0) + 1)
    }
    return map
  }, [library.videos])

  const tree = useMemo(() => buildTagTree(library.tags), [library.tags])
  const tagFilter = useMemo(() => compileQuery(tagFilterText), [tagFilterText])
  const flatTagRows = useMemo(() => flattenTagRows(tree), [tree])
  const searchedTagRows = useMemo(
    () => tagFilterText.trim()
      ? flatTagRows.filter((row) => queryMatches(tagFilter, row.tag.name))
      : undefined,
    [flatTagRows, tagFilter, tagFilterText, pinyinVersion],
  )
  const parentTagIds = useMemo(
    () => library.tags.filter((tag) => library.tags.some((child) => child.parentId === tag.id)).map((tag) => tag.id),
    [library.tags],
  )
  const siblingsByParent = useMemo(() => {
    const map = new Map<string | null, YouTubeTag[]>()
    for (const tag of library.tags) {
      const list = map.get(tag.parentId)
      if (list) list.push(tag)
      else map.set(tag.parentId, [tag])
    }
    for (const list of map.values()) {
      list.sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || left.sortOrder - right.sortOrder
        || left.createdAt - right.createdAt)
    }
    return map
  }, [library.tags])
  const siblingsOf = (tag: YouTubeTag): YouTubeTag[] =>
    (siblingsByParent.get(tag.parentId) ?? []).filter((entry) => entry.pinned === tag.pinned)
  const expandedTagSet = useMemo(() => new Set(expandedTags), [expandedTags])
  const existingChannelIds = useMemo(() => new Set(library.channels.map((channel) => channel.id)), [library.channels])
  const existingPlaylistIds = useMemo(() => new Set(library.playlists.map((playlist) => playlist.id)), [library.playlists])

  const go = (view: YouTubeView) => {
    navigateToAddress(
      youtubeViewPath(view),
      youtubeSearchParams({
        sort,
        range,
        prefs: { sort: preferredSort, range: preferredRange },
      }),
    )
    onNavigate?.()
  }

  const retry = () => {
    void reloadLibrary().catch((error) => {
      useUi.getState().toast({
        title: t('youtube.failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    })
  }

  const reportTagFailure = (error: unknown) => {
    useUi.getState().toast({
      title: t('youtube.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }

  const startDraft = (parentId: string | null) => {
    setDraftParent(parentId)
    if (parentId) expandTag(parentId)
  }

  const finishDraft = (name: string) => {
    const trimmed = name.trim()
    const parentId = draftParent ?? null
    setDraftParent(undefined)
    if (!trimmed) return
    void addTag({ name: trimmed, color: ORGANIZER_COLORS[0], parentId })
      .then(() => {
        if (parentId) expandTag(parentId)
      })
      .catch(reportTagFailure)
  }

  const finishRename = (tag: YouTubeTag, name: string) => {
    const trimmed = name.trim()
    setRenamingTagId(null)
    if (!trimmed || trimmed === tag.name) return
    void editTag(tag.id, { name: trimmed }).catch(reportTagFailure)
  }

  const deleteTagWithConfirm = async (tag: YouTubeTag) => {
    const confirmed = await confirm({
      title: t('youtube.tags.delete_title'),
      description: t('youtube.tags.delete_desc', { name: tag.name }),
    })
    if (!confirmed) return
    try {
      await removeTag(tag.id)
    } catch (error) {
      reportTagFailure(error)
    }
  }

  const moveTag = (tag: YouTubeTag, direction: -1 | 1) => {
    const siblings = siblingsOf(tag)
    const index = siblings.findIndex((entry) => entry.id === tag.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= siblings.length) return
    const ids = siblings.map((entry) => entry.id)
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    void reorderTags(ids).catch(reportTagFailure)
  }

  const dropTag = (sourceId: string, targetId: string | null) => {
    setDraggingTagId(null)
    setDropTargetId(null)
    if (sourceId === targetId) return
    if (targetId && wouldCreateTagCycle(library.tags, sourceId, targetId)) {
      useUi.getState().toast({ title: t('youtube.failed'), description: t('youtube.tags.none_hint'), tone: 'danger' })
      return
    }
    const nextOrder = siblingsByParent.get(targetId)?.length ?? 0
    void editTag(sourceId, { parentId: targetId, sortOrder: nextOrder })
      .then(() => {
        if (targetId) expandTag(targetId)
      })
      .catch(reportTagFailure)
  }

  const copyTagName = (name: string) => {
    if (!navigator.clipboard?.writeText) {
      reportTagFailure(new Error(t('youtube.tags.copy_name')))
      return
    }
    void navigator.clipboard.writeText(name).then(() => {
      useUi.getState().toast({ title: t('common.copied'), tone: 'success' })
    }).catch(reportTagFailure)
  }

  const searchTagVideos = (name: string) => {
    navigateToAddress(
      '/youtube',
      youtubeSearchParams({ q: name, sort, range, prefs: { sort: preferredSort, range: preferredRange } }),
    )
    onNavigate?.()
  }

  const dialogs = (
    <>
      <AddChannelDialog
        open={addChannelOpen}
        onClose={() => setAddChannelOpen(false)}
        existingIds={existingChannelIds}
      />
      <AddPlaylistDialog
        open={addPlaylistOpen}
        onClose={() => setAddPlaylistOpen(false)}
        existingIds={existingPlaylistIds}
      />
      <TagManagerModal open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} tags={library.tags} />
    </>
  )

  if (collapsed) {
    return (
      <div
        data-collapsed="true"
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        <div className="flex w-full shrink-0 flex-col items-center gap-1 border-b border-[var(--border-subtle)] py-1">
          <Tooltip label={t('app.tabs.youtube')} side="right">
            <a
              href="/youtube"
              aria-label={t('app.tabs.youtube')}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                go({ kind: 'explore' })
              }}
              className="flex size-8 items-center justify-center rounded-[var(--r-sm)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <YoutubeBrandMark />
            </a>
          </Tooltip>
          {onCollapse && (
            <Tooltip label={t('youtube.sidebar.expand')} side="right">
              <IconButton label={t('youtube.sidebar.expand')} size="sm" onClick={onCollapse}>
                <PanelLeftOpen size={16} />
              </IconButton>
            </Tooltip>
          )}
        </div>
        <nav
          aria-label={t('app.tabs.youtube')}
          className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-2"
        >
          <SidebarLink
            collapsed
            href="/youtube"
            label={t('youtube.sidebar.explore')}
            icon={<Compass size={16} />}
            active={activeView.kind === 'explore'}
            onActivate={() => go({ kind: 'explore' })}
          />
          <SidebarLink
            collapsed
            href="/youtube/all"
            label={t('youtube.sidebar.all')}
            icon={<ListVideo size={16} />}
            active={activeView.kind === 'library' && activeView.filter === 'all'}
            onActivate={() => go({ kind: 'library', filter: 'all' })}
          />
          <SidebarLink
            collapsed
            href="/youtube/pinned"
            label={t('youtube.sidebar.pinned')}
            icon={<Pin size={16} />}
            active={activeView.kind === 'library' && activeView.filter === 'pinned'}
            onActivate={() => go({ kind: 'library', filter: 'pinned' })}
          />
          <SidebarLink
            collapsed
            href="/youtube/favorites"
            label={t('youtube.sidebar.favorites')}
            icon={<Heart size={16} />}
            active={activeView.kind === 'library' && activeView.filter === 'favorites'}
            onActivate={() => go({ kind: 'library', filter: 'favorites' })}
          />
          <Tooltip label={t('youtube.sidebar.manage_tags')} side="right">
            <IconButton
              label={t('youtube.sidebar.manage_tags')}
              size="sm"
              onClick={() => setTagManagerOpen(true)}
            >
              <Tags size={16} />
            </IconButton>
          </Tooltip>
        </nav>
        {dialogs}
      </div>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
      {!hideHeader && (
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-2">
        <a
          href="/youtube"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            go({ kind: 'explore' })
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] px-1 py-1 hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <YoutubeBrandMark />
          <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('app.tabs.youtube')}
          </span>
        </a>
        {onCollapse && (
          <Tooltip label={t('youtube.sidebar.collapse')} side="bottom">
            <IconButton
              label={t('youtube.sidebar.collapse')}
              size="sm"
              onClick={onCollapse}
            >
              <PanelLeftClose size={15} />
            </IconButton>
          </Tooltip>
        )}
      </div>
      )}

      {libraryStatus === 'error' && (
        <div className="mx-2 mt-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5">
          <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
            {t('youtube.failed')}
          </p>
          {libraryError && (
            <p className="mt-0.5 line-clamp-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {libraryError}
            </p>
          )}
          <Button size="sm" variant="ghost" className="mt-0.5 px-0" onClick={retry}>
            {t('youtube.retry')}
          </Button>
        </div>
      )}

      <nav aria-label={t('app.tabs.youtube')} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        <div className="space-y-0.5">
          <SidebarLink
            href="/youtube"
            label={t('youtube.sidebar.explore')}
            icon={<Compass size={15} />}
            active={activeView.kind === 'explore'}
            onActivate={() => go({ kind: 'explore' })}
          />
          <SidebarLink
            href="/youtube/all"
            label={t('youtube.sidebar.all')}
            icon={<ListVideo size={15} />}
            count={counts.all}
            active={activeView.kind === 'library' && activeView.filter === 'all'}
            onActivate={() => go({ kind: 'library', filter: 'all' })}
          />
          <SidebarLink
            href="/youtube/pinned"
            label={t('youtube.sidebar.pinned')}
            icon={<Pin size={15} />}
            count={counts.pinned}
            active={activeView.kind === 'library' && activeView.filter === 'pinned'}
            onActivate={() => go({ kind: 'library', filter: 'pinned' })}
          />
          <SidebarLink
            href="/youtube/favorites"
            label={t('youtube.sidebar.favorites')}
            icon={<Heart size={15} />}
            count={counts.favorites}
            active={activeView.kind === 'library' && activeView.filter === 'favorites'}
            onActivate={() => go({ kind: 'library', filter: 'favorites' })}
          />
        </div>

        <ChannelSection
          channels={library.channels}
          activeChannelId={activeView.kind === 'channel' ? activeView.channelId : null}
          expanded={expandedSections.includes('channels')}
          onToggle={() => toggleSection('channels')}
          onOpenAdd={() => setAddChannelOpen(true)}
          onSelect={(channelId) => go({ kind: 'channel', channelId })}
        />

        <PlaylistSection
          playlists={library.playlists}
          activePlaylistId={activeView.kind === 'playlist' ? activeView.playlistId : null}
          expanded={expandedSections.includes('playlists')}
          onToggle={() => toggleSection('playlists')}
          onOpenAdd={() => setAddPlaylistOpen(true)}
          onSelect={(playlistId) => go({ kind: 'playlist', playlistId })}
        />

        <section
          className={cn('mt-3', dropTargetId === 'root' && 'rounded-[var(--r-md)] ring-1 ring-[var(--accent)]')}
          onDragOver={(event) => {
            if (!draggingTagId) return
            event.preventDefault()
            setDropTargetId('root')
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null)
          }}
          onDrop={(event) => {
            const source = droppedTagId(event.dataTransfer)
            if (!source) return
            event.preventDefault()
            dropTag(source, null)
          }}
        >
          <div className="flex items-center gap-1 px-1">
            <SectionLabel className="min-w-0 flex-1 px-0 pt-0 pb-0">{t('youtube.sidebar.tags')}</SectionLabel>
            {parentTagIds.length > 0 && (
              <IconButton
                label={expandedTags.length ? t('tags.collapse_all') : t('tags.expand_all')}
                size="xs"
                onClick={() => setExpandedTags(expandedTags.length ? [] : parentTagIds)}
              >
                <ChevronsUpDown size={13} />
              </IconButton>
            )}
            <IconButton label={t('youtube.sidebar.new_tag')} size="xs" onClick={() => startDraft(null)}>
              <Plus size={13} />
            </IconButton>
            <IconButton label={t('youtube.sidebar.manage_tags')} size="xs" onClick={() => setTagManagerOpen(true)}>
              <Settings2 size={13} />
            </IconButton>
          </div>
          {library.tags.length > 0 && (
            <div className="px-1 pb-1">
              <FilterInput
                value={tagFilterText}
                onChange={setTagFilterText}
                query={tagFilter}
                label={t('tags.filter')}
                placeholder={t('tags.filter_placeholder')}
              />
            </div>
          )}
          {searchedTagRows && (
            <p className="px-2 pb-1 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
              {t('tags.match_count', { value0: searchedTagRows.length })}
            </p>
          )}
          {library.tags.length === 0 ? (
            <div className="px-1 py-1">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('youtube.sidebar.no_tags')}
              </p>
              <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={() => startDraft(null)}>
                {t('youtube.sidebar.new_tag')}
              </Button>
            </div>
          ) : (
            <div className="px-1 pt-0.5">
              <TagTree
                nodes={tree}
                flat={searchedTagRows}
                expanded={expandedTagSet}
                activeTagId={activeView.kind === 'tag' ? activeView.tagId : null}
                countFor={(tagId) => tagCounts.get(tagId) ?? 0}
                query={tagFilter}
                siblingsOf={siblingsOf}
                draft={draftParent === undefined ? null : { parentId: draftParent }}
                onDraftCommit={finishDraft}
                onDraftCancel={() => setDraftParent(undefined)}
                onToggle={toggleTagExpanded}
                onSelect={(tag) => go({ kind: 'tag', tagId: tag.id })}
                onStartRename={(id) => { window.setTimeout(() => setRenamingTagId(id), 0) }}
                onFinishRename={finishRename}
                onCancelRename={() => setRenamingTagId(null)}
                onCreateChild={(tag) => { window.setTimeout(() => startDraft(tag.id), 0) }}
                onEditColor={(tag, color) => { void editTag(tag.id, { color }).catch(reportTagFailure) }}
                onTogglePin={(tag) => { void editTag(tag.id, { pinned: !tag.pinned }).catch(reportTagFailure) }}
                onManage={() => setTagManagerOpen(true)}
                onDelete={(tag) => { void deleteTagWithConfirm(tag) }}
                onCopyName={copyTagName}
                onSearchVideos={searchTagVideos}
                onMove={moveTag}
                onDragStart={setDraggingTagId}
                onDragEnd={() => { setDraggingTagId(null); setDropTargetId(null) }}
                onDrop={dropTag}
                draggingId={draggingTagId}
                dropTargetId={dropTargetId}
                renamingId={renamingTagId}
              />
            </div>
          )}
        </section>
      </nav>
      {dialogs}
    </div>
  )
}

function YoutubeBrandMark() {
  return (
    <svg viewBox="0 0 28 20" width={22} height={16} aria-hidden="true" className="shrink-0">
      <rect width="28" height="20" rx="5" fill="var(--youtube-brand)" />
      <path d="M11 5.5 19.5 10 11 14.5Z" fill="var(--yt-logo-fg)" />
    </svg>
  )
}

function flattenTagRows(nodes: YouTubeTagNode[], depth = 0): { tag: YouTubeTag; depth: number }[] {
  return nodes.flatMap((node) => [
    { tag: node, depth },
    ...flattenTagRows(node.children, depth + 1),
  ])
}
