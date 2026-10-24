/**
 * The listening heatmap: a year of plays, the totals behind it, and the five palettes the reference
 * app offers. The API groups by the reader's local day; this page only chooses the window and paint.
 */
import { useId, useState, type ReactElement } from 'react'
import { CalendarDays, Clock3, Flame, Play, Trophy } from 'lucide-react'
import type { MusicHistorySummary } from '@shared/music/api'
import { cn } from '../../../lib/cn'
import { Button } from '../../../components/primitives'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import {
  ListeningHeatmap,
  MUSIC_HEATMAP_PALETTES,
  type MusicHeatmapPalette,
} from './parts/P2ListeningHeatmap'
import { MusicStatCard } from './parts/StatCard'
import { PAGE_STACK, QueryError, formatDate, formatDateTime } from './parts/P2QueryState'
import { playTracks } from './parts/playback'

const PALETTE_STORAGE_KEY = 'inkstone.music.heatmap.palette'

function readPalette(): MusicHeatmapPalette {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY)
    if (stored && (MUSIC_HEATMAP_PALETTES as readonly string[]).includes(stored)) {
      return stored as MusicHeatmapPalette
    }
  } catch {
    // Private mode or a blocked origin: the default palette still paints the page.
  }
  return 'green'
}

function localDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return formatDate(new Date(year, month - 1, day).getTime())
}

function Stats({ summary }: { summary: MusicHistorySummary }): ReactElement {
  const top = summary.topTracks[0]
  return (
    <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 xl:grid-cols-5">
      <MusicStatCard
        icon={<Play size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.total_plays')}
        value={musicText('music.heatmap.plays', { count: summary.totalPlays })}
      />
      <MusicStatCard
        icon={<CalendarDays size={16} aria-hidden="true" />}
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
        value={summary.mostActiveDay ? localDate(summary.mostActiveDay.date) : musicText('music.heatmap.no_value')}
        hint={summary.mostActiveDay
          ? musicText('music.heatmap.plays', { count: summary.mostActiveDay.count })
          : undefined}
      />
      <MusicStatCard
        icon={<Clock3 size={16} aria-hidden="true" />}
        label={musicText('music.heatmap.latest')}
        value={summary.latest ? summary.latest.track.title : musicText('music.heatmap.no_value')}
        hint={summary.latest ? formatDateTime(summary.latest.playedAt) : undefined}
      />
    </div>
  )
}

export function HeatmapPage(): ReactElement {
  const headingId = useId()
  const [palette, setPalette] = useState<MusicHeatmapPalette>(readPalette)
  const query = useMusicQuery(() => musicApi.historySummary(), [])
  const summary = query.data

  const choosePalette = (next: MusicHeatmapPalette): void => {
    setPalette(next)
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next)
    } catch {
      // The chosen palette still applies for this visit; persistence is the only thing lost.
    }
  }

  const playTop = (): void => {
    const tracks = summary?.topTracks.map((row) => row.track) ?? []
    if (tracks.length > 0) playTracks(tracks)
  }

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader
        level={1}
        id={headingId}
        title={musicText('music.page.heatmap')}
        description={musicText('music.heatmap.description')}
        action={summary && summary.topTracks.length > 0
          ? { label: musicText('music.heatmap.play_top'), onClick: playTop }
          : undefined}
      />

      {query.status === 'error' && !summary ? (
        <QueryError
          title={musicText('music.heatmap.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !summary ? (
        <div className="flex flex-col gap-[var(--sp-4)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          <div className="grid gap-[var(--sp-3)] sm:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="h-[84px] rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
            ))}
          </div>
          <div className="h-[220px] rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
        </div>
      ) : summary ? (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.heatmap.error')} detail={query.error} onRetry={query.reload} />
          )}
          <Stats summary={summary} />

          <section
            aria-label={musicText('music.history.heatmap')}
            className="flex flex-col gap-[var(--sp-4)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-[var(--sp-3)]">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
                  {musicText('music.history.heatmap')}
                </h2>
                <p className="mt-[var(--sp-1)] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
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
            <ListeningHeatmap days={summary.days} weeks={53} palette={palette} showMonths />
            {summary.totalPlays === 0 && (
              <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                {musicText('music.heatmap.empty_hint')}
              </p>
            )}
          </section>
        </>
      ) : (
        <div className="flex flex-col items-center gap-[var(--sp-3)] py-[var(--sp-10)] text-center">
          <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            {musicText('music.heatmap.empty')}
          </p>
          <Button variant="secondary" onClick={query.reload}>
            {musicText('common.retry')}
          </Button>
        </div>
      )}
    </section>
  )
}
