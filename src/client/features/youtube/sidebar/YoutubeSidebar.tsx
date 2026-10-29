import { useMemo, useState } from 'react'
import {
  Compass,
  Heart,
  ListVideo,
  PanelLeft,
  PanelLeftClose,
  Pin,
  Plus,
  Settings2,
  Tags,
} from 'lucide-react'
import type { SortKey, TimeRange, YouTubeView } from '@shared/youtube/model'
import {
  buildTagTree,
  youtubeSearchParams,
  youtubeViewPath,
} from '@shared/youtube/model'
import { t } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { Button, IconButton, SectionLabel } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { useYoutubeStore } from '../store'
import { AddChannelDialog } from '../library/AddChannelDialog'
import { AddPlaylistDialog } from '../library/AddPlaylistDialog'
import { TagManagerModal } from '../tags/TagManagerModal'
import { SidebarLink } from './SidebarLink'
import { ChannelSection } from './ChannelSection'
import { PlaylistSection } from './PlaylistSection'
import { TagTree } from './TagTree'

export function YoutubeSidebar({
  activeView,
  sort,
  range,
  collapsed = false,
  onNavigate,
  onCollapse,
}: {
  activeView: YouTubeView
  sort: SortKey
  range: TimeRange
  collapsed?: boolean
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

  const [addChannelOpen, setAddChannelOpen] = useState(false)
  const [addPlaylistOpen, setAddPlaylistOpen] = useState(false)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)

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
      <aside
        data-collapsed="true"
        aria-label={t('app.tabs.youtube')}
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
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
        {onCollapse && (
          <div className="flex w-full shrink-0 justify-center pb-2">
            <Tooltip label={t('youtube.sidebar.expand')} side="right">
              <IconButton label={t('youtube.sidebar.expand')} size="sm" onClick={onCollapse}>
                <PanelLeft size={16} />
              </IconButton>
            </Tooltip>
          </div>
        )}
        {dialogs}
      </aside>
    )
  }

  return (
    <aside
      aria-label={t('app.tabs.youtube')}
      className="flex h-full min-h-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
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

        <section className="mt-3">
          <div className="flex items-center gap-1 px-1">
            <SectionLabel className="min-w-0 flex-1 px-0 pt-0 pb-0">{t('youtube.sidebar.tags')}</SectionLabel>
            <IconButton
              label={t('youtube.sidebar.new_tag')}
              size="xs"
              onClick={() => setTagManagerOpen(true)}
            >
              <Plus size={13} />
            </IconButton>
            <IconButton
              label={t('youtube.sidebar.manage_tags')}
              size="xs"
              onClick={() => setTagManagerOpen(true)}
            >
              <Settings2 size={13} />
            </IconButton>
          </div>
          {library.tags.length === 0 ? (
            <div className="px-1 py-1">
              <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                {t('youtube.sidebar.no_tags')}
              </p>
              <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={() => setTagManagerOpen(true)}>
                {t('youtube.sidebar.new_tag')}
              </Button>
            </div>
          ) : (
            <div className="px-1 pt-0.5">
              <TagTree
                nodes={tree}
                expandedTags={expandedTagSet}
                activeTagId={activeView.kind === 'tag' ? activeView.tagId : null}
                countFor={(tagId) => tagCounts.get(tagId) ?? 0}
                onToggle={toggleTagExpanded}
                onSelect={(tagId) => go({ kind: 'tag', tagId })}
              />
            </div>
          )}
        </section>
      </nav>
      {dialogs}
    </aside>
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
