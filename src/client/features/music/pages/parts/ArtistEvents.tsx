/**
 * An artist's activity feed: text, pictures, and the catalog items an event attaches.
 *
 * The upstream feed is cursor-paged (`before`), so the component keeps the rows it has already
 * read and appends the next page. Pictures and avatars go through the cover route, which proxies
 * the provider host; an attached song starts playing, and an attached album or playlist opens.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Heart, MessageCircle } from 'lucide-react'
import type { MusicAlbumSummary, MusicArtistEvent, MusicPlaylistSummary } from '@shared/music/api'
import type { MusicTrack } from '@shared/music/model'
import { musicArtistNames } from '@shared/music/format'
import { Button } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { navigateToAddress } from '../../../../lib/app-history'
import { musicApi } from '../../api'
import { Cover } from '../../components/Cover'
import { musicText } from '../../components/labels'
import { musicPathFor } from '../../music-address'
import { useMusicPlayer } from '../../store/player'
import { musicErrorMessage, PageError } from './PageState'
import { formatDateTime } from './P2QueryState'

const PAGE_SIZE = 20

type LoadStatus = 'loading' | 'ready' | 'error'

function appendUnique(current: MusicArtistEvent[], next: MusicArtistEvent[]): MusicArtistEvent[] {
  const seen = new Set(current.map((item) => item.id))
  return [...current, ...next.filter((item) => !seen.has(item.id))]
}

function AttachmentCard({
  kind,
  coverUrl,
  title,
  meta,
  onOpen,
}: {
  kind: 'song' | 'album' | 'playlist'
  coverUrl: string
  title: string
  meta: string
  onOpen: () => void
}): ReactElement {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-[var(--sp-2)] rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-2)] text-left transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      onClick={onOpen}
    >
      <Cover src={coverUrl} size="sm" radius="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{title}</span>
        <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {meta || musicText(`music.search.type.${kind}`)}
        </span>
      </span>
      <span className="shrink-0 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
        {musicText(`music.search.type.${kind}`)}
      </span>
    </button>
  )
}

function EventAttachments({ event }: { event: MusicArtistEvent }): ReactElement | null {
  const cards: ReactElement[] = []
  if (event.song) {
    const song: MusicTrack = event.song
    cards.push(
      <AttachmentCard
        key={`song:${song.id}`}
        kind="song"
        coverUrl={song.coverUrl}
        title={song.title}
        meta={musicArtistNames(song)}
        onOpen={() => {
          void useMusicPlayer.getState().playTrack(song)
        }}
      />,
    )
  }
  if (event.album) {
    const album: MusicAlbumSummary = event.album
    cards.push(
      <AttachmentCard
        key={`album:${album.id}`}
        kind="album"
        coverUrl={album.coverUrl}
        title={album.name}
        meta={album.artists.join(' / ')}
        onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: album.id }))}
      />,
    )
  }
  if (event.playlist) {
    const playlist: MusicPlaylistSummary = event.playlist
    cards.push(
      <AttachmentCard
        key={`playlist:${playlist.id}`}
        kind="playlist"
        coverUrl={playlist.coverUrl}
        title={playlist.name}
        meta={playlist.creator ?? ''}
        onOpen={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: playlist.id }))}
      />,
    )
  }
  if (cards.length === 0) return null
  return <div className="grid gap-2 sm:grid-cols-2">{cards}</div>
}

function EventRow({ event }: { event: MusicArtistEvent }): ReactElement {
  return (
    <article className="flex flex-col gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-[var(--sp-3)]">
      <header className="flex items-center gap-[var(--sp-2)]">
        <Cover src={event.authorAvatarUrl} size="xs" radius="full" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
            {event.authorName}
          </span>
          <time
            className="text-[length:var(--text-11)] text-[var(--text-quaternary)]"
            dateTime={event.createdAt > 0 ? new Date(event.createdAt).toISOString() : undefined}
          >
            {formatDateTime(event.createdAt)}
          </time>
        </div>
      </header>

      {event.content && (
        <p className="m-0 whitespace-pre-line break-words text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
          {event.content}
        </p>
      )}
      {event.forwarded && (
        <p className="m-0 whitespace-pre-line break-words border-s-2 border-[var(--border-default)] ps-2 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {event.forwarded}
        </p>
      )}

      {event.pictures.length > 0 && (
        <div className="grid grid-cols-3 gap-1">
          {event.pictures.map((url, index) => (
            <Cover key={`${event.id}:${index}`} src={url} size="md" radius="sm" />
          ))}
        </div>
      )}

      <EventAttachments event={event} />

      <footer className="flex items-center gap-[var(--sp-3)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        <span
          className="inline-flex items-center gap-1"
          aria-label={musicText('music.artist.events.likes', { count: event.likedCount })}
        >
          <Heart size={12} aria-hidden="true" />
          {event.likedCount}
        </span>
        <span
          className="inline-flex items-center gap-1"
          aria-label={musicText('music.artist.events.comments', { count: event.commentCount })}
        >
          <MessageCircle size={12} aria-hidden="true" />
          {event.commentCount}
        </span>
      </footer>
    </article>
  )
}

function EventsSkeleton(): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={musicText('common.loading')}
      className="flex flex-col gap-[var(--sp-3)]"
    >
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="h-32 rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" aria-hidden="true" />
      ))}
    </div>
  )
}

export function ArtistEvents({ artistId }: { artistId: string }): ReactElement {
  const [items, setItems] = useState<MusicArtistEvent[]>([])
  const [before, setBefore] = useState<number | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setItems([])
    setBefore(null)
    setStatus('loading')
    setError(null)
    setMoreError(null)
    musicApi.artistEvents(artistId, null, PAGE_SIZE)
      .then((page) => {
        if (!active) return
        setItems(page.items)
        setBefore(page.before)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(musicErrorMessage(reason))
        setStatus('error')
      })
    return () => {
      active = false
    }
  }, [artistId, reloadKey])

  const loadMore = useCallback(async (): Promise<void> => {
    if (before === null || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await musicApi.artistEvents(artistId, before, PAGE_SIZE)
      setItems((current) => appendUnique(current, page.items))
      setBefore(page.before)
    } catch (reason: unknown) {
      setMoreError(musicErrorMessage(reason))
    } finally {
      setLoadingMore(false)
    }
  }, [artistId, before, loadingMore])

  if (status === 'loading') return <EventsSkeleton />
  if (status === 'error') {
    return (
      <PageError
        compact
        error={error}
        title={musicText('music.artist.events.error')}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    )
  }
  if (items.length === 0) {
    return (
      <Empty
        art="subscriptions"
        title={musicText('music.artist.empty_events.title')}
        description={musicText('music.artist.empty_events.description')}
      />
    )
  }

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <ul className="m-0 flex list-none flex-col gap-[var(--sp-3)] p-0">
        {items.map((event) => (
          <li key={event.id}>
            <EventRow event={event} />
          </li>
        ))}
      </ul>
      {moreError && (
        <PageError
          compact
          error={moreError}
          title={musicText('music.artist.events.more_failed')}
          onRetry={() => {
            void loadMore()
          }}
        />
      )}
      {before !== null && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            loading={loadingMore}
            onClick={() => {
              void loadMore()
            }}
          >
            {musicText('music.artist.events.load_more')}
          </Button>
        </div>
      )}
    </div>
  )
}
