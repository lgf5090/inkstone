import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, PanelLeft } from 'lucide-react'
import type { SortKey, TimeRange, YouTubeVideo } from '@shared/youtube/model'
import {
  youtubeSearchParams,
  youtubeViewKey,
  youtubeViewPath,
} from '@shared/youtube/model'
import { t } from '../../lib/i18n'
import { useBreakpoint } from '../../lib/hooks'
import { replaceAddress } from '../../lib/app-history'
import { IS_DEMO_MODE } from '../../lib/runtime'
import { IconButton } from '../../components/primitives'
import { Drawer, Tooltip } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { Resizer } from '../shell/Resizer'
import { useYouTubeAddress } from './address'
import { useYoutubeStore } from './store'
import { YOUTUBE_SIDEBAR_WIDTH, YOUTUBE_SPLIT_RATIO } from './prefs'
import { YoutubeSidebar } from './sidebar/YoutubeSidebar'
import { DiscoverToolbar } from './discover/DiscoverToolbar'
import { RangeChips, RANGE_LABELS } from './discover/RangeChips'
import { VideoList } from './discover/VideoList'
import { VideoDetail } from './detail/VideoDetail'
import { QuotaDialog } from './quota/QuotaDialog'
import { SplitPane } from '../../components/split-pane'
import './youtube.css'

export function YoutubeApp() {
  const address = useYouTubeAddress()
  const breakpoint = useBreakpoint()
  const isDesktop = breakpoint === 'desktop'
  const isMobile = breakpoint === 'mobile'

  const ensureLibrary = useYoutubeStore((state) => state.ensureLibrary)
  const reloadLibrary = useYoutubeStore((state) => state.reloadLibrary)
  const library = useYoutubeStore((state) => state.library)
  const libraryStatus = useYoutubeStore((state) => state.libraryStatus)
  const sidebarWidth = useYoutubeStore((state) => state.sidebarWidth)
  const sidebarCollapsed = useYoutubeStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useYoutubeStore((state) => state.toggleSidebar)
  const setSidebarWidth = useYoutubeStore((state) => state.setSidebarWidth)
  const splitRatio = useYoutubeStore((state) => state.splitRatio)
  const setSplitRatio = useYoutubeStore((state) => state.setSplitRatio)
  const sort = useYoutubeStore((state) => state.sort)
  const range = useYoutubeStore((state) => state.range)
  const setPrefs = useYoutubeStore((state) => state.setPrefs)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [listBusy, setListBusy] = useState(false)
  const [summary, setSummary] = useState<number | null>(null)
  const [foundVideo, setFoundVideo] = useState<YouTubeVideo | null>(null)

  const viewKey = youtubeViewKey(address.view)

  useEffect(() => {
    if (!IS_DEMO_MODE) ensureLibrary()
  }, [ensureLibrary])

  useEffect(() => {
    setSummary(null)
    setFoundVideo(null)
    setListBusy(false)
  }, [viewKey])

  const handleSummary = useCallback((count: number) => setSummary(count), [])
  const handleBusy = useCallback((busy: boolean) => setListBusy(busy), [])
  const handleFound = useCallback((video: YouTubeVideo | null) => setFoundVideo(video), [])

  const writeAddress = useCallback(
    (next: { q: string; sort: SortKey; range: TimeRange; videoId: string | null }) => {
      replaceAddress(
        youtubeViewPath(address.view),
        youtubeSearchParams({
          q: next.q,
          sort: next.sort,
          range: next.range,
          videoId: next.videoId,
          prefs: { sort, range },
        }),
      )
    },
    [address.view, sort, range],
  )

  const selectVideo = (video: YouTubeVideo) => {
    setFoundVideo(video)
    writeAddress({ q: address.q, sort: address.sort, range: address.range, videoId: video.id })
  }

  const backToList = () => {
    writeAddress({ q: address.q, sort: address.sort, range: address.range, videoId: null })
  }

  const changeQuery = (query: string) => {
    writeAddress({
      q: query.slice(0, 200),
      sort: address.sort,
      range: address.range,
      videoId: address.view.kind === 'explore' ? null : address.videoId,
    })
  }

  const changeSort = (next: SortKey) => {
    writeAddress({ q: address.q, sort: next, range: address.range, videoId: address.videoId })
    setPrefs({ sort: next })
  }

  const changeRange = (next: TimeRange) => {
    writeAddress({ q: address.q, sort: address.sort, range: next, videoId: address.videoId })
    setPrefs({ range: next })
  }

  const refresh = () => {
    if (address.view.kind === 'library' || address.view.kind === 'tag') {
      void reloadLibrary().catch((error) => {
        useUi.getState().toast({
          title: t('youtube.failed'),
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
      })
      return
    }
    setRefreshKey((value) => value + 1)
  }

  const selectedVideo = useMemo(() => {
    if (!address.videoId) return null
    if (foundVideo?.id === address.videoId) return foundVideo
    return library.videos.find((video) => video.id === address.videoId)?.data ?? null
  }, [address.videoId, foundVideo, library.videos])

  const view = address.view
  const viewTitle = (() => {
    if (view.kind === 'explore') {
      return address.q
        ? t('youtube.view.search', { query: address.q })
        : t('youtube.view.popular', { range: t(RANGE_LABELS[address.range]) })
    }
    if (view.kind === 'library') {
      if (view.filter === 'pinned') return t('youtube.view.pinned')
      if (view.filter === 'favorites') return t('youtube.view.favorites')
      return t('youtube.view.all')
    }
    if (view.kind === 'tag') {
      const tag = library.tags.find((entry) => entry.id === view.tagId)
      return tag ? `${t('youtube.view.tag')} · ${tag.name}` : t('youtube.view.tag')
    }
    if (view.kind === 'channel') {
      return library.channels.find((entry) => entry.id === view.channelId)?.data.title ?? t('youtube.view.channel')
    }
    return library.playlists.find((entry) => entry.id === view.playlistId)?.data.title ?? t('youtube.view.playlist')
  })()

  const externalLink =
    view.kind === 'channel'
      ? {
          href: `https://www.youtube.com/channel/${encodeURIComponent(view.channelId)}`,
          label: t('youtube.view.view_channel'),
        }
      : view.kind === 'playlist'
        ? {
            href: `https://www.youtube.com/playlist?list=${encodeURIComponent(view.playlistId)}`,
            label: t('youtube.view.view_playlist'),
          }
        : null

  const busy = listBusy || libraryStatus === 'loading'

  if (IS_DEMO_MODE) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('youtube.demo_unavailable')}
      </div>
    )
  }

  const list = (
    <VideoList
      key={viewKey}
      address={address}
      refreshKey={refreshKey}
      selectedId={address.videoId}
      onSelect={selectVideo}
      onSummary={handleSummary}
      onBusyChange={handleBusy}
      onVideoFound={handleFound}
    />
  )

  return (
    <div
      data-youtube-app=""
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      {!isDesktop && (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
          <Tooltip label={t('youtube.sidebar.expand')} side="bottom">
            <IconButton
              label={t('youtube.sidebar.expand')}
              size="sm"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
          <span className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('app.tabs.youtube')}
          </span>
        </header>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
        {isDesktop && (
          <>
            <div
              style={{ width: sidebarCollapsed ? YOUTUBE_SIDEBAR_WIDTH.collapsed : sidebarWidth }}
              className="shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]"
            >
              <YoutubeSidebar
                activeView={address.view}
                sort={address.sort}
                range={address.range}
                collapsed={sidebarCollapsed}
                onCollapse={toggleSidebar}
              />
            </div>
            {!sidebarCollapsed && (
              <Resizer
                label={t('youtube.sidebar.resize')}
                value={sidebarWidth}
                min={YOUTUBE_SIDEBAR_WIDTH.min}
                max={YOUTUBE_SIDEBAR_WIDTH.max}
                onChange={setSidebarWidth}
                onReset={() => setSidebarWidth(YOUTUBE_SIDEBAR_WIDTH.default)}
              />
            )}
          </>
        )}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-base)]">
          <DiscoverToolbar
            address={address}
            busy={busy}
            onQueryChange={changeQuery}
            onSortChange={changeSort}
            onRefresh={refresh}
            onOpenQuota={() => setQuotaOpen(true)}
          />
          {view.kind === 'explore' && <RangeChips value={address.range} onChange={changeRange} />}
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-1.5">
            <h2 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {viewTitle}
            </h2>
            {externalLink && (
              <a
                href={externalLink.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)] hover:underline"
              >
                <ExternalLink size={11} aria-hidden="true" />
                {externalLink.label}
              </a>
            )}
            {summary !== null && (
              <span className="tabular ml-auto text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('youtube.view.count', { count: summary })}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1">
            {isMobile ? (
              address.videoId ? (
                <VideoDetail video={selectedVideo} onBack={backToList} />
              ) : (
                list
              )
            ) : (
              <SplitPane
                orientation="horizontal"
                ratio={splitRatio}
                onChange={setSplitRatio}
                min={YOUTUBE_SPLIT_RATIO.min}
                max={YOUTUBE_SPLIT_RATIO.max}
                label={t('youtube.sidebar.resize')}
                first={list}
                second={<VideoDetail video={selectedVideo} />}
              />
            )}
          </div>
        </main>
      </div>

      <Drawer
        open={!isDesktop && drawerOpen}
        onClose={() => setDrawerOpen(false)}
        side="left"
        width={sidebarWidth}
        title={t('app.tabs.youtube')}
      >
        <YoutubeSidebar
          activeView={address.view}
          sort={address.sort}
          range={address.range}
          onNavigate={() => setDrawerOpen(false)}
        />
      </Drawer>

      <QuotaDialog open={quotaOpen} onClose={() => setQuotaOpen(false)} />
    </div>
  )
}
