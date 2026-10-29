import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { YouTubeAddress, YouTubeVideo } from '@shared/youtube/model'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Empty, LoadingBlock, Skeleton } from '../../../components/feedback'
import { useUi } from '../../../store/ui'
import { fetchChannelVideos, fetchDiscover, fetchPlaylistVideos } from '../api'
import { useYoutubeStore } from '../store'
import { filterPopular } from './popular-filter'
import { VideoRow } from './VideoRow'

type ListMode = 'popular' | 'search' | 'channel' | 'playlist' | 'library'
type LoadStatus = 'loading' | 'ready' | 'error'

export function VideoList({
  address,
  refreshKey,
  selectedId,
  onSelect,
  onSummary,
  onBusyChange,
  onVideoFound,
}: {
  address: YouTubeAddress
  refreshKey: number
  selectedId: string | null
  onSelect: (video: YouTubeVideo) => void
  onSummary: (count: number) => void
  onBusyChange: (busy: boolean) => void
  onVideoFound: (video: YouTubeVideo | null) => void
}) {
  const view = address.view
  const mode: ListMode =
    view.kind === 'explore'
      ? address.q.trim()
        ? 'search'
        : 'popular'
      : view.kind === 'library' || view.kind === 'tag'
        ? 'library'
        : view.kind
  const submittedQuery = mode === 'search' ? address.q.trim() : ''
  const channelId = view.kind === 'channel' ? view.channelId : ''
  const playlistId = view.kind === 'playlist' ? view.playlistId : ''
  const { sort, range } = address

  const library = useYoutubeStore((state) => state.library)
  const libraryStatus = useYoutubeStore((state) => state.libraryStatus)
  const libraryError = useYoutubeStore((state) => state.libraryError)
  const reloadLibrary = useYoutubeStore((state) => state.reloadLibrary)

  const [status, setStatus] = useState<LoadStatus>(mode === 'library' ? 'ready' : 'loading')
  const [error, setError] = useState<string | null>(null)
  const [remote, setRemote] = useState<YouTubeVideo[]>([])
  const [pager, setPager] = useState<{ tokens: string[]; index: number }>({ tokens: [''], index: 0 })
  const [nextToken, setNextToken] = useState<string | null>(null)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (token: string, generation: number, signal: AbortSignal) => {
      setStatus('loading')
      setError(null)
      try {
        let items: YouTubeVideo[] = []
        let next: string | null = null
        if (mode === 'popular') {
          const result = await fetchDiscover({ q: '', sort, range }, signal)
          items = result.items
        } else if (mode === 'search') {
          const result = await fetchDiscover(
            { q: submittedQuery, sort, range, pageToken: token || undefined },
            signal,
          )
          items = result.items
          next = result.nextPageToken
        } else if (mode === 'channel') {
          const result = await fetchChannelVideos(channelId, token || undefined, signal)
          items = result.items
          next = result.nextPageToken
        } else if (mode === 'playlist') {
          const result = await fetchPlaylistVideos(playlistId, token || undefined, signal)
          items = result.items
          next = result.nextPageToken
        } else {
          setStatus('ready')
          return
        }
        if (generation !== generationRef.current) return
        setRemote(items)
        setNextToken(next)
        setStatus('ready')
      } catch (cause) {
        if (generation !== generationRef.current || signal.aborted) return
        setError(messageOf(cause))
        setStatus('error')
      }
    },
    [mode, submittedQuery, sort, range, channelId, playlistId],
  )

  const requestPage = useCallback(
    (tokens: string[], index: number) => {
      const generation = ++generationRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setPager({ tokens, index })
      void load(tokens[index] ?? '', generation, controller.signal)
    },
    [load],
  )

  useEffect(() => {
    if (mode === 'library') {
      generationRef.current++
      abortRef.current?.abort()
      setRemote([])
      setNextToken(null)
      setPager({ tokens: [''], index: 0 })
      setStatus('ready')
      setError(null)
      return
    }
    setRemote([])
    setNextToken(null)
    requestPage([''], 0)
    return () => {
      generationRef.current++
      abortRef.current?.abort()
    }
  }, [mode, submittedQuery, sort, range, refreshKey, channelId, playlistId, requestPage])

  useEffect(() => {
    onBusyChange(status === 'loading')
  }, [status, onBusyChange])

  useEffect(() => () => onBusyChange(false), [onBusyChange])

  const visible = useMemo(() => {
    if (mode === 'library') {
      const filter = view.kind === 'library' ? view.filter : null
      const tagId = view.kind === 'tag' ? view.tagId : null
      const needle = address.q.trim().toLowerCase()
      const rows = library.videos.filter((row) => {
        if (filter === 'pinned' && !row.pinned) return false
        if (filter === 'favorites' && !row.favorited) return false
        if (tagId && !row.tagIds.includes(tagId)) return false
        if (!needle) return true
        return matches(row.data, needle)
      })
      rows.sort((left, right) => right.updatedAt - left.updatedAt)
      return rows.map((row) => row.data)
    }
    if (mode === 'popular') return filterPopular(remote, range, sort)
    if (mode === 'search') return remote
    const needle = address.q.trim().toLowerCase()
    if (!needle) return remote
    return remote.filter((video) => matches(video, needle))
  }, [mode, view, address.q, library.videos, remote, range, sort])

  const sourceVideos = useMemo(
    () => (mode === 'library' ? library.videos.map((row) => row.data) : remote),
    [mode, library.videos, remote],
  )

  useEffect(() => {
    onSummary(visible.length)
  }, [visible.length, onSummary])

  useEffect(() => {
    onVideoFound(selectedId ? sourceVideos.find((video) => video.id === selectedId) ?? null : null)
  }, [selectedId, sourceVideos, onVideoFound])

  const savedById = useMemo(
    () => new Map(library.videos.map((row) => [row.id, row])),
    [library.videos],
  )

  const retry = () => requestPage([''], 0)
  const retryLibrary = () => {
    void reloadLibrary().catch((cause) => {
      useUi.getState().toast({
        title: t('youtube.failed'),
        description: messageOf(cause),
        tone: 'danger',
      })
    })
  }

  const libraryInitialLoading =
    mode === 'library' && (libraryStatus === 'idle' || libraryStatus === 'loading') && library.videos.length === 0
  if (libraryInitialLoading) return <LoadingBlock />

  if (mode === 'library' && libraryStatus === 'error' && library.videos.length === 0) {
    return (
      <Empty
        art="select"
        title={t('youtube.failed')}
        description={libraryError ?? undefined}
        action={
          <Button size="sm" onClick={retryLibrary}>
            {t('youtube.retry')}
          </Button>
        }
      />
    )
  }

  if (mode !== 'library' && status === 'loading') return <RowsSkeleton />

  if (mode !== 'library' && status === 'error') {
    return (
      <Empty
        art="search"
        title={t('youtube.failed')}
        description={error ?? undefined}
        action={
          <Button size="sm" onClick={retry}>
            {t('youtube.retry')}
          </Button>
        }
      />
    )
  }

  if (visible.length === 0) {
    return <Empty art={emptyArt(mode)} title={t(emptyCopy(mode))} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {mode === 'library' && library.truncated && (
        <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('youtube.truncated')}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul role="list" className="divide-y divide-[var(--border-subtle)]">
          {visible.map((video) => (
            <VideoRow
              key={video.id}
              video={video}
              saved={savedById.get(video.id)}
              allTags={library.tags}
              selected={video.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
        {(mode === 'search' || mode === 'channel' || mode === 'playlist') && (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<ChevronLeft size={13} />}
              disabled={pager.index === 0 || status === 'loading'}
              onClick={() => requestPage(pager.tokens, pager.index - 1)}
            >
              {t('youtube.pagination.prev')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              trailing={<ChevronRight size={13} />}
              disabled={!nextToken || status === 'loading'}
              onClick={() => {
                if (!nextToken) return
                requestPage([...pager.tokens.slice(0, pager.index + 1), nextToken], pager.index + 1)
              }}
            >
              {t('youtube.pagination.next')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function matches(video: YouTubeVideo, needle: string): boolean {
  return `${video.title}\n${video.channelTitle}\n${video.description}`.toLowerCase().includes(needle)
}

function emptyCopy(mode: ListMode): MessageKey {
  if (mode === 'popular') return 'youtube.empty.explore'
  if (mode === 'search') return 'youtube.empty.search'
  if (mode === 'channel') return 'youtube.empty.channel'
  if (mode === 'playlist') return 'youtube.empty.playlist'
  return 'youtube.empty.library'
}

function emptyArt(mode: ListMode): 'search' | 'subscriptions' | 'folder' | 'select' {
  if (mode === 'channel') return 'subscriptions'
  if (mode === 'playlist') return 'folder'
  if (mode === 'library') return 'select'
  return 'search'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function RowsSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-1 p-2">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex gap-3 p-2" style={{ opacity: 1 - index * 0.18 }}>
          <Skeleton className="aspect-video w-32 shrink-0 rounded-[var(--r-sm)]" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
