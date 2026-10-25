/**
 * Listening history: the plays the server kept, the collections they came from, and the heatmap
 * entry that summarises them. Each tab owns its loader so a broken recent list cannot hide the songs.
 */
import { useId, useMemo, useState, type ReactElement } from 'react'
import { Clock3, Flame, Play, Trash2, Trophy } from 'lucide-react'
import type { MusicHistorySummary } from '@shared/music/api'
import { cn } from '../../../lib/cn'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicRecentEntry, MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import type { MusicHistoryItem } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { Cover } from '../components/Cover'
import { MusicTabs, type MusicTabItem } from '../components/Tabs'
import { musicText } from '../components/labels'
import { MediaCard } from './parts/P2MediaCard'
import {
  ListeningHeatmap,
  MUSIC_HEATMAP_PALETTES,
  type MusicHeatmapPalette,
} from './parts/P2ListeningHeatmap'
import { MusicStatCard } from './parts/StatCard'
import {
  PAGE_STACK,
  QueryError,
  formatDateTime,
  toastFailure,
} from './parts/P2QueryState'
import { getLocale } from '../../../lib/i18n'
import { playTracks } from './parts/playback'
import { useUi } from '../../../store/ui'

type HistoryTab = 'songs' | 'playlists' | 'albums' | 'podcasts'
type SourceFilter = 'all' | 'local' | 'online'

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

const SOURCE_FILTERS: ReadonlyArray<{ value: SourceFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'music.history.source.all' },
  { value: 'local', labelKey: 'music.history.source.local' },
  { value: 'online', labelKey: 'music.history.source.online' },
]

function sourceOf(track: MusicTrack): SourceFilter {
  return track.provider === 'netease' ? 'online' : 'local'
}

function matchesSource(track: MusicTrack, filter: SourceFilter): boolean {
  return filter === 'all' || sourceOf(track) === filter
}

const PALETTE_STORAGE_KEY = 'inkstone.music.heatmap.palette'

function readPalette(): MusicHeatmapPalette {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY)
    if (stored && (MUSIC_HEATMAP_PALETTES as readonly string[]).includes(stored)) {
      return stored as MusicHeatmapPalette
    }
  } catch {
    // Private mode or a blocked origin: the default palette still paints the card.
  }
  return 'green'
}

/** A card value has one line: the long local date is legible in a row, not in five columns. */
function compactDay(value: string): string {
  const [year, month, day] = value.split('-')
  return year && month && day ? `${year}/${month}/${day}` : value
}

function compactDateTime(value: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

function Stats({ summary }: { summary: MusicHistorySummary }): ReactElement {
  const top = summary.topTracks[0]
  return (
    <div className="grid gap-[var(--sp-3)] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
      <MusicStatCard
        icon={<Play size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.total_plays')}
        value={musicText('music.heatmap.plays', { count: summary.totalPlays })}
      />
      <MusicStatCard
        icon={<Flame size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.active_days')}
        value={musicText('music.heatmap.days', { count: summary.activeDays })}
      />
      <MusicStatCard
        icon={<Trophy size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.top_track')}
        value={top ? top.track.title : musicText('music.heatmap.no_value')}
        hint={top ? musicText('music.heatmap.plays', { count: top.count }) : undefined}
      />
      <MusicStatCard
        icon={<Flame size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.most_active_day')}
        value={summary.mostActiveDay ? compactDay(summary.mostActiveDay.date) : musicText('music.heatmap.no_value')}
        hint={summary.mostActiveDay
          ? musicText('music.heatmap.plays', { count: summary.mostActiveDay.count })
          : undefined}
      />
      <MusicStatCard
        icon={<Clock3 size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.latest')}
        value={summary.latest ? summary.latest.track.title : musicText('music.heatmap.no_value')}
        hint={summary.latest ? compactDateTime(summary.latest.playedAt) : undefined}
      />
    </div>
  )
}

export function HistoryPage(): ReactElement {
  const [tab, setTab] = useState<HistoryTab>('songs')
  const [source, setSource] = useState<SourceFilter>('all')
  const [clearing, setClearing] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [palette, setPalette] = useState<MusicHeatmapPalette>(readPalette)
  const headingId = useId()

  const historyQuery = useMusicQuery(() => musicApi.history(100), [])
  const recentQuery = useMusicQuery(() => musicApi.recent(), [])
  const summaryQuery = useMusicQuery(() => musicApi.historySummary(), [])

  const played = useMemo<PlayedItem[]>(() => {
    const items = historyQuery.data?.items ?? []
    const out: PlayedItem[] = []
    for (const item of items) {
      if (item.track) out.push({ entry: item, track: item.track })
    }
    return out
  }, [historyQuery.data])

  const songs = useMemo(
    () => dedupeConsecutive(played.filter((item) => item.track.kind === 'song' && matchesSource(item.track, source))),
    [played, source],
  )
  const podcasts = useMemo(
    () => dedupeConsecutive(played.filter((item) => item.track.kind === 'podcast' && matchesSource(item.track, source))),
    [played, source],
  )
  const recent = useMemo<MusicRecentEntry[]>(() => {
    const items = recentQuery.data?.items ?? []
    const out: MusicRecentEntry[] = []
    for (const item of items) {
      const parsed = recentOf(item)
      if (parsed) out.push(parsed)
    }
    return out
  }, [recentQuery.data])
  const playlists = useMemo(() => recent.filter((item) => item.kind === 'playlist'), [recent])
  const albums = useMemo(() => recent.filter((item) => item.kind === 'album'), [recent])
  const radios = useMemo(() => recent.filter((item) => item.kind === 'radio'), [recent])

  const tabs: MusicTabItem<HistoryTab>[] = [
    { value: 'songs', label: musicText('music.history.tab.songs'), count: songs.length },
    { value: 'playlists', label: musicText('music.history.tab.playlists'), count: playlists.length },
    { value: 'albums', label: musicText('music.history.tab.albums'), count: albums.length },
    { value: 'podcasts', label: musicText('music.history.tab.podcasts'), count: podcasts.length + radios.length },
  ]

  const discoverHref = musicPathFor({ kind: 'home' })
  const summary = summaryQuery.data
  const canClear = (summary?.totalPlays ?? 0) > 0 && !clearing
  const topTracks = summary?.topTracks.map((row) => row.track) ?? []

  const choosePalette = (next: MusicHeatmapPalette): void => {
    setPalette(next)
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next)
    } catch {
      // The chosen palette still applies for this visit; persistence is the only thing lost.
    }
  }

  const clearHistory = async (): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.history.clear_confirm_title'),
      description: musicText('music.history.clear_confirm_body'),
      confirmLabel: musicText('music.history.clear'),
      tone: 'danger',
    })
    if (!approved) return
    setClearing(true)
    try {
      await musicApi.clearHistory()
      historyQuery.reload()
      summaryQuery.reload()
      useUi.getState().toast({ title: musicText('music.history.cleared'), tone: 'success' })
    } catch (error) {
      toastFailure(musicText('music.history.clear_failed'), error)
    } finally {
      setClearing(false)
    }
  }

  const removePlay = async (entry: MusicHistoryItem): Promise<void> => {
    const approved = await confirm({
      title: musicText('music.history.delete_confirm_title'),
      description: musicText('music.history.delete_confirm_body', { title: entry.track?.title ?? '' }),
      confirmLabel: musicText('music.history.delete'),
      tone: 'danger',
    })
    if (!approved) return
    setDeletingId(entry.id)
    try {
      await musicApi.deleteHistory(entry.id)
      historyQuery.reload()
      summaryQuery.reload()
      useUi.getState().toast({ title: musicText('music.history.deleted'), tone: 'success' })
    } catch (error) {
      toastFailure(musicText('music.history.delete_failed'), error)
    } finally {
      setDeletingId(null)
    }
  }

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
        <div className="flex flex-wrap items-center justify-end gap-[var(--sp-2)]">
          <Button
            variant="secondary"
            size="sm"
            icon={<Trophy size={14} />}
            disabled={topTracks.length === 0}
            onClick={() => playTracks(topTracks)}
          >
            {musicText('music.heatmap.play_top')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canClear}
            loading={clearing}
            onClick={() => {
              void clearHistory()
            }}
          >
            {musicText('music.history.clear')}
          </Button>
        </div>
      </header>

      {summaryQuery.status === 'loading' && !summary ? (
        <div className="grid gap-[var(--sp-3)] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="h-[84px] rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
          ))}
        </div>
      ) : summary ? (
        <Stats summary={summary} />
      ) : null}

      <section
        aria-label={musicText('music.history.heatmap')}
        className="flex flex-col gap-[var(--sp-3)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-[var(--sp-3)]">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {musicText('music.history.heatmap')}
            </h2>
            <p className="mt-[var(--sp-1)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {summary
                ? musicText('music.history.heatmap_summary', { count: summary.totalPlays })
                : musicText('common.loading')}
              {' · '}
              {musicText('music.heatmap.description')}
            </p>
          </div>
          <div
            role="group"
            aria-label={musicText('music.heatmap.palette')}
            className="flex items-center gap-[var(--sp-2)]"
          >
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {musicText('music.heatmap.palette')}
            </span>
            {MUSIC_HEATMAP_PALETTES.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={musicText(`music.heatmap.palette.${value}`)}
                aria-pressed={palette === value}
                onClick={() => choosePalette(value)}
                className={cn(
                  'music-heatmap-swatch music-heatmap size-6 rounded-full border-2 transition-transform duration-[var(--dur-fast)]',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
                  palette === value
                    ? 'scale-110 border-[var(--text-primary)]'
                    : 'border-transparent hover:scale-105',
                  `music-heatmap--${value}`,
                )}
              />
            ))}
          </div>
        </div>
        {summaryQuery.status === 'error' && !summary ? (
          <QueryError
            title={musicText('music.history.error')}
            detail={summaryQuery.error}
            onRetry={summaryQuery.reload}
          />
        ) : summaryQuery.status === 'loading' && !summary ? (
          <div className="h-[120px] w-full rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" aria-hidden="true" />
        ) : (
          <>
            <ListeningHeatmap days={summary?.days ?? []} weeks={53} palette={palette} fill />
            {summary && summary.totalPlays === 0 && (
              <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {musicText('music.heatmap.empty_hint')}
              </p>
            )}
          </>
        )}
      </section>

      <div className="flex flex-col gap-[var(--sp-3)]">
        <MusicTabs<HistoryTab>
          value={tab}
          label={musicText('music.history.tabs_label')}
          onChange={setTab}
          items={tabs}
        />

        {(tab === 'songs' || tab === 'podcasts') && (
          <div
            role="group"
            aria-label={musicText('music.history.source_label')}
            className="flex flex-wrap items-center gap-[var(--sp-2)]"
          >
            {SOURCE_FILTERS.map((filter) => (
              <Button
                key={filter.value}
                variant={source === filter.value ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={source === filter.value}
                onClick={() => setSource(filter.value)}
              >
                {musicText(filter.labelKey)}
              </Button>
            ))}
          </div>
        )}

        <div role="tabpanel" aria-label={musicText(`music.history.tab.${tab}`)}>
          {tab === 'songs' && (
            <HistoryList
              items={songs}
              loading={historyQuery.status === 'loading' && !historyQuery.data}
              error={historyQuery.status === 'error' && !historyQuery.data ? historyQuery.error : null}
              onRetry={historyQuery.reload}
              onDelete={(entry) => {
                void removePlay(entry)
              }}
              deletingId={deletingId}
              emptyTitle={musicText('music.history.empty.songs')}
              emptyHint={musicText('music.history.empty.songs_hint')}
              discoverHref={discoverHref}
            />
          )}
          {tab === 'playlists' && (
            <RecentGrid
              entries={playlists}
              loading={recentQuery.status === 'loading' && !recentQuery.data}
              error={recentQuery.status === 'error' && !recentQuery.data ? recentQuery.error : null}
              onRetry={recentQuery.reload}
              emptyTitle={musicText('music.history.empty.playlists')}
              emptyHint={musicText('music.history.empty.playlists_hint')}
              discoverHref={discoverHref}
            />
          )}
          {tab === 'albums' && (
            <RecentGrid
              entries={albums}
              loading={recentQuery.status === 'loading' && !recentQuery.data}
              error={recentQuery.status === 'error' && !recentQuery.data ? recentQuery.error : null}
              onRetry={recentQuery.reload}
              emptyTitle={musicText('music.history.empty.albums')}
              emptyHint={musicText('music.history.empty.albums_hint')}
              discoverHref={discoverHref}
            />
          )}
          {tab === 'podcasts' && (
            <div className="flex flex-col gap-[var(--sp-5)]">
              <RecentGrid
                entries={radios}
                loading={recentQuery.status === 'loading' && !recentQuery.data}
                error={recentQuery.status === 'error' && !recentQuery.data ? recentQuery.error : null}
                onRetry={recentQuery.reload}
                emptyTitle={musicText('music.history.empty.radios')}
                emptyHint={musicText('music.history.empty.radios_hint')}
                discoverHref={musicPathFor({ kind: 'podcast' })}
              />
              <section aria-label={musicText('music.history.tab.podcasts')} className="flex flex-col gap-[var(--sp-2)]">
                <h2 className="text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]">
                  {musicText('music.history.episodes')}
                </h2>
                <HistoryList
                  items={podcasts}
                  loading={historyQuery.status === 'loading' && !historyQuery.data}
                  error={historyQuery.status === 'error' && !historyQuery.data ? historyQuery.error : null}
                  onRetry={historyQuery.reload}
                  onDelete={(entry) => {
                    void removePlay(entry)
                  }}
                  deletingId={deletingId}
                  emptyTitle={musicText('music.history.empty.podcasts')}
                  emptyHint={musicText('music.history.empty.podcasts_hint')}
                  discoverHref={musicPathFor({ kind: 'podcast' })}
                />
              </section>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function dedupeConsecutive(items: readonly PlayedItem[]): PlayedItem[] {
  const out: PlayedItem[] = []
  let previousTrackId = ''
  for (const item of items) {
    if (item.track.id === previousTrackId) continue
    previousTrackId = item.track.id
    out.push(item)
  }
  return out
}

function RecentGrid({
  entries,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyHint,
  discoverHref,
}: {
  entries: readonly MusicRecentEntry[]
  loading: boolean
  error: string | null
  onRetry: () => void
  emptyTitle: string
  emptyHint: string
  discoverHref: string
}): ReactElement {
  if (loading) {
    return (
      <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-[74px] rounded-[var(--r-md)] bg-[var(--bg-sunken)]" />
        ))}
      </div>
    )
  }
  if (error) return <QueryError title={musicText('music.history.recent_error')} detail={error} onRetry={onRetry} />
  if (entries.length === 0) {
    return (
      <Empty
        art="folder"
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
    <div className="music-card-grid">
      {entries.map((entry) => (
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
}

function HistoryList({
  items,
  loading,
  error,
  onRetry,
  onDelete,
  deletingId,
  emptyTitle,
  emptyHint,
  discoverHref,
}: {
  items: readonly PlayedItem[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onDelete: (entry: MusicHistoryItem) => void
  deletingId: string | null
  emptyTitle: string
  emptyHint: string
  discoverHref: string
}): ReactElement {
  const queue = useMemo(() => items.map((item) => item.track), [items])
  const play = (track: MusicTrack): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
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
            onClick={() => play(track)}
          >
            <Play size={14} />
          </IconButton>
          <IconButton
            label={musicText('music.history.delete_track', { title: track.title })}
            size="sm"
            className="me-[var(--sp-1)]"
            disabled={deletingId === entry.id}
            onClick={() => onDelete(entry)}
          >
            <Trash2 size={14} />
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
