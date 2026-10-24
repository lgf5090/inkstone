/**
 * Listening history: the plays the server kept, the collections they came from, and the heatmap
 * entry that summarises them. Each tab owns its loader so a broken recent list cannot hide the songs.
 */
import { useId, useMemo, useState, type ReactElement } from 'react'
import { CalendarDays, Play } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicRecentEntry, MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import type { MusicHistoryItem } from '../store/library'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { Cover } from '../components/Cover'
import { MusicTabs } from '../components/Tabs'
import { musicText } from '../components/labels'
import { MediaCard } from './parts/P2MediaCard'
import { ListeningHeatmap } from './parts/P2ListeningHeatmap'
import {
  PAGE_STACK,
  QueryError,
  formatDateTime,
} from './parts/P2QueryState'

type HistoryTab = 'songs' | 'podcasts' | 'recent'

interface PlayedItem {
  entry: MusicHistoryItem
  track: MusicTrack
}

const RECENT_KIND_KEYS: Record<MusicRecentEntry['kind'], string> = {
  playlist: 'music.page.playlist',
  album: 'music.page.album',
  radio: 'music.page.podcast',
  artist: 'music.page.artist',
}

export function HistoryPage(): ReactElement {
  const [tab, setTab] = useState<HistoryTab>('songs')
  const [heatmapOpen, setHeatmapOpen] = useState(false)
  const headingId = useId()

  const historyQuery = useMusicQuery(() => musicApi.history(100), [])
  const recentQuery = useMusicQuery(() => musicApi.recent(), [])

  const played = useMemo<PlayedItem[]>(() => {
    const items = historyQuery.data?.items ?? []
    const out: PlayedItem[] = []
    for (const item of items) {
      if (item.track) out.push({ entry: item, track: item.track })
    }
    return out
  }, [historyQuery.data])

  const songs = useMemo(() => played.filter((item) => item.track.kind === 'song'), [played])
  const podcasts = useMemo(() => played.filter((item) => item.track.kind === 'podcast'), [played])
  const recent = useMemo<MusicRecentEntry[]>(() => {
    const items = recentQuery.data?.items ?? []
    const out: MusicRecentEntry[] = []
    for (const item of items) {
      const parsed = recentOf(item)
      if (parsed) out.push(parsed)
    }
    return out
  }, [recentQuery.data])

  const heatEntries = useMemo(() => played.map((item) => item.entry), [played])
  const discoverHref = musicPathFor({ kind: 'home' })

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <header className="music-section-header">
        <div className="music-section-header__text">
          <h1 id={headingId} className="music-section-header__title">
            {musicText('music.page.history')}
          </h1>
          <p className="music-section-header__description">
            {musicText('music.history.description')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-[var(--sp-1)]">
          <Button variant="ghost" size="sm" disabled>
            {musicText('music.history.clear')}
          </Button>
          <span className="max-w-[220px] text-end text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">
            {musicText('music.history.clear_unavailable')}
          </span>
        </div>
      </header>

      <section
        aria-label={musicText('music.history.heatmap')}
        className="flex flex-col gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-[var(--sp-2)]">
          <div>
            <h3 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {musicText('music.history.heatmap')}
            </h3>
            <p className="mt-[var(--sp-1)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {musicText('music.history.heatmap_summary', { count: heatEntries.length })}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<CalendarDays size={14} />}
            disabled={heatEntries.length === 0}
            onClick={() => setHeatmapOpen(true)}
          >
            {musicText('music.history.heatmap_open')}
          </Button>
        </div>
        {historyQuery.status === 'error' && !historyQuery.data ? (
          <QueryError
            title={musicText('music.history.error')}
            detail={historyQuery.error}
            onRetry={historyQuery.reload}
          />
        ) : historyQuery.status === 'loading' && !historyQuery.data ? (
          <div className="h-[74px] w-full rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" aria-hidden="true" />
        ) : (
          <ListeningHeatmap entries={heatEntries} weeks={12} />
        )}
      </section>

      <div className="flex flex-col gap-[var(--sp-3)]">
        <MusicTabs<HistoryTab>
          value={tab}
          label={musicText('music.history.tabs_label')}
          onChange={setTab}
          items={[
            { value: 'songs', label: musicText('music.history.tab.songs'), count: songs.length },
            { value: 'podcasts', label: musicText('music.history.tab.podcasts'), count: podcasts.length },
            { value: 'recent', label: musicText('music.history.tab.recent'), count: recent.length },
          ]}
        />

        <div role="tabpanel" aria-label={musicText(`music.history.tab.${tab}`)}>
          {tab === 'songs' && (
            <HistoryList
              items={songs}
              loading={historyQuery.status === 'loading' && !historyQuery.data}
              error={historyQuery.status === 'error' && !historyQuery.data ? historyQuery.error : null}
              onRetry={historyQuery.reload}
              emptyTitle={musicText('music.history.empty.songs')}
              emptyHint={musicText('music.history.empty.songs_hint')}
              discoverHref={discoverHref}
            />
          )}
          {tab === 'podcasts' && (
            <HistoryList
              items={podcasts}
              loading={historyQuery.status === 'loading' && !historyQuery.data}
              error={historyQuery.status === 'error' && !historyQuery.data ? historyQuery.error : null}
              onRetry={historyQuery.reload}
              emptyTitle={musicText('music.history.empty.podcasts')}
              emptyHint={musicText('music.history.empty.podcasts_hint')}
              discoverHref={discoverHref}
            />
          )}
          {tab === 'recent' && (
            recentQuery.status === 'error' && !recentQuery.data ? (
              <QueryError
                title={musicText('music.history.recent_error')}
                detail={recentQuery.error}
                onRetry={recentQuery.reload}
              />
            ) : recentQuery.status === 'loading' && !recentQuery.data ? (
              <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="h-[74px] rounded-[var(--r-md)] bg-[var(--bg-sunken)]" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <Empty
                art="folder"
                compact
                title={musicText('music.history.empty.recent')}
                description={musicText('music.history.empty.recent_hint')}
                action={(
                  <Button variant="secondary" onClick={() => navigateToAddress(discoverHref)}>
                    {musicText('music.common.discover')}
                  </Button>
                )}
              />
            ) : (
              <div className="music-card-grid">
                {recent.map((entry) => (
                  <MediaCard
                    key={entry.id}
                    href={recentHref(entry)}
                    title={entry.name}
                    meta={musicText(RECENT_KIND_KEYS[entry.kind])}
                    description={musicText('music.history.recent_meta', {
                      date: formatDateTime(entry.lastPlayedAt),
                      count: entry.playCount,
                    })}
                    coverUrl={entry.coverUrl}
                  />
                ))}
              </div>
            )
          )}
        </div>
      </div>

      <Modal
        open={heatmapOpen}
        onClose={() => setHeatmapOpen(false)}
        title={musicText('music.history.heatmap')}
        description={musicText('music.history.heatmap_summary', { count: heatEntries.length })}
        width={760}
      >
        <ListeningHeatmap entries={heatEntries} weeks={52} />
      </Modal>
    </section>
  )
}

function HistoryList({
  items,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyHint,
  discoverHref,
}: {
  items: readonly PlayedItem[]
  loading: boolean
  error: string | null
  onRetry: () => void
  emptyTitle: string
  emptyHint: string
  discoverHref: string
}): ReactElement {
  const queue = useMemo(() => items.map((item) => item.track), [items])
  const play = (track: MusicTrack): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
    void useMusicLibrary.getState().recordHistory({ track, contextType: 'history' })
  }

  if (loading) {
    return (
      <ul className="flex flex-col gap-[var(--sp-0-5)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="h-[52px] rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
        ))}
      </ul>
    )
  }
  if (error) {
    return <QueryError title={musicText('music.history.error')} detail={error} onRetry={onRetry} />
  }
  if (items.length === 0) {
    return (
      <Empty
        art="archive"
        compact
        title={emptyTitle}
        description={emptyHint}
        action={(
          <Button variant="secondary" onClick={() => navigateToAddress(discoverHref)}>
            {musicText('music.common.discover')}
          </Button>
        )}
      />
    )
  }

  return (
    <ul className="flex flex-col gap-[var(--sp-0-5)]">
      {items.map(({ entry, track }) => (
        <li
          key={entry.id}
          className="flex items-center gap-[var(--sp-1)] rounded-[var(--r-sm)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)]"
        >
          <button
            type="button"
            onClick={() => play(track)}
            className="flex min-w-0 flex-1 items-center gap-[var(--sp-3)] rounded-[var(--r-sm)] px-[var(--sp-2)] py-[var(--sp-1)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
          >
            <Cover trackId={track.id} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                {track.title}
              </span>
              <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {musicText('music.history.row_meta', {
                  artist: musicArtistNames(track),
                  date: formatDateTime(entry.playedAt),
                })}
              </span>
            </span>
            <span className="shrink-0 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
              {formatDuration(track.durationMs)}
            </span>
          </button>
          <IconButton
            label={musicText('music.history.play_track', { title: track.title })}
            size="sm"
            className="me-[var(--sp-1)]"
            onClick={() => play(track)}
          >
            <Play size={14} />
          </IconButton>
        </li>
      ))}
    </ul>
  )
}

function recentHref(entry: MusicRecentEntry): string {
  switch (entry.kind) {
    case 'playlist':
      return musicPathFor({ kind: 'playlist', id: entry.providerId })
    case 'album':
      return musicPathFor({ kind: 'album', id: entry.providerId })
    case 'radio':
      return musicPathFor({ kind: 'podcastDetail', id: entry.providerId })
    case 'artist':
      return musicPathFor({ kind: 'artist', id: entry.providerId })
  }
}

function recentOf(value: Record<string, unknown>): MusicRecentEntry | null {
  const kind = value.kind
  const providerId = value.providerId
  const name = value.name
  if (typeof kind !== 'string' || !Object.hasOwn(RECENT_KIND_KEYS, kind)) return null
  if (typeof providerId !== 'string' || !providerId) return null
  if (typeof name !== 'string' || !name) return null
  return {
    id: typeof value.id === 'string' ? value.id : `${kind}:${providerId}`,
    kind: kind as MusicRecentEntry['kind'],
    providerId,
    name,
    coverUrl: typeof value.coverUrl === 'string' ? value.coverUrl : '',
    lastPlayedAt: typeof value.lastPlayedAt === 'number' ? value.lastPlayedAt : 0,
    playCount: typeof value.playCount === 'number' ? value.playCount : 1,
  }
}
