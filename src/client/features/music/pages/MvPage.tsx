/** Music videos: a card grid and a detail screen that plays the video through the same-origin stream. */
import { useEffect, useId, useState, type ReactElement } from 'react'
import { ChevronLeft } from 'lucide-react'
import { formatDuration, formatPlayCount } from '@shared/music/format'
import type { MusicMvDetail, MusicMvSummary, MusicPlaylistSummary } from '@shared/music/api'
import type { MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicUi } from '../store/ui'
import { Pager } from '../components/Pager'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import { MediaCard, MediaGridSkeleton } from './parts/P2MediaCard'
import { PAGE_STACK, QueryError, formatDate, onMusicLink } from './parts/P2QueryState'

const PAGE_SIZE = 30

export function MvPage(): ReactElement {
  const page = useMusicUi((state) => state.page)
  if (page.kind === 'mvDetail') return <MvDetailPage key={page.id} id={page.id} />
  return <MvListPage />
}

function MvListPage(): ReactElement {
  const [pageIndex, setPageIndex] = useState(1)
  const headingId = useId()
  const query = useMusicQuery(
    () => musicApi.mvs('ALL', pageIndex, PAGE_SIZE),
    [pageIndex],
  )
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader
        level={1}
        id={headingId}
        title={musicText('music.page.mv')}
        description={musicText('music.mv.list_description')}
      />

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.mv.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
        <MediaGridSkeleton count={8} aspect="video" />
      ) : items.length === 0 ? (
        <Empty
          art="search"
          title={musicText('music.mv.empty')}
          description={musicText('music.mv.empty_hint')}
        />
      ) : (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.mv.error')} detail={query.error} onRetry={query.reload} />
          )}
          <div className="music-card-grid">
            {items.map((item) => (
              <MvCard key={item.id} item={item} />
            ))}
          </div>
          <Pager page={pageIndex} pageCount={pageCount} onChange={setPageIndex} />
        </>
      )}
    </section>
  )
}

function MvCard({ item }: { item: MusicPlaylistSummary }): ReactElement {
  // The discovery route is typed as a playlist page while its provider answers with MV rows;
  // read the MV fields when present and keep the playlist fields as the older fallback.
  const mv = item as unknown as Partial<MusicMvSummary>
  const meta = [mv.artist, item.creator].filter(Boolean).join(' · ')
  const duration = typeof mv.durationMs === 'number' && mv.durationMs > 0
    ? formatDuration(mv.durationMs)
    : ''
  return (
    <MediaCard
      href={musicPathFor({ kind: 'mvDetail', id: item.id })}
      title={item.name}
      meta={meta || item.description}
      coverUrl={item.coverUrl}
      aspect="video"
      badge={duration || undefined}
    />
  )
}

function MvDetailPage({ id }: { id: string }): ReactElement {
  const query = useMusicQuery(async () => {
    const detail = await musicApi.mv(id)
    const track = await ensureMvTrack(detail.mv)
    return { detail, track }
  }, [id])
  const [videoFailed, setVideoFailed] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [videoKey, setVideoKey] = useState(0)

  const trackId = query.data?.track.id ?? ''
  useEffect(() => {
    setVideoFailed(false)
    setVideoError(null)
  }, [trackId, videoKey])

  const backHref = musicPathFor({ kind: 'mv' })
  const detail: MusicMvDetail | null = query.data?.detail ?? null

  return (
    <section aria-label={musicText('music.page.mv_detail')} className={PAGE_STACK}>
      <div>
        <a
          href={backHref}
          onClick={(event) => onMusicLink(event, backHref)}
          className="inline-flex items-center gap-[var(--sp-1)] rounded-[var(--r-sm)] text-[length:var(--text-12)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {musicText('music.mv.back')}
        </a>
      </div>

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.mv.detail_error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
        <div className="flex flex-col gap-[var(--sp-4)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          <div className="aspect-video w-full rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
          <div className="h-[22px] w-2/3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
          <div className="h-[12px] w-1/3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
        </div>
      ) : detail && query.data ? (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.mv.detail_error')} detail={query.error} onRetry={query.reload} />
          )}

          <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]">
            <video
              key={videoKey}
              controls
              playsInline
              preload="metadata"
              poster={detail.mv.coverUrl || undefined}
              src={musicApi.streamUrl(query.data.track.id)}
              aria-label={musicText('music.mv.play_aria', { title: detail.mv.name })}
              className="aspect-video w-full"
              onError={(event) => {
                setVideoFailed(true)
                setVideoError(event.currentTarget.error?.message || null)
              }}
            />
          </div>

          {videoFailed && (
            <QueryError
              title={musicText('music.mv.video_error')}
              detail={videoError}
              onRetry={() => setVideoKey((value) => value + 1)}
            />
          )}

          <header className="flex flex-col gap-[var(--sp-2)]">
            <h1 className="font-[family-name:var(--font-display)] text-[length:var(--text-26)] font-semibold leading-tight tracking-[var(--tracking-title)] text-[var(--text-primary)]">
              {detail.mv.name}
            </h1>
            <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
              {detail.mv.artist || musicText('music.mv.unknown_artist')}
            </p>
            <p className="flex flex-wrap items-center gap-[var(--sp-2)] text-[length:var(--text-11-5)] tabular text-[var(--text-tertiary)]">
              <span>{formatDuration(detail.mv.durationMs)}</span>
              <span aria-hidden="true">·</span>
              <span>{musicText('music.mv.play_count', { count: formatPlayCount(detail.mv.playCount) })}</span>
              {detail.publishTime > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{musicText('music.mv.published', { date: formatDate(detail.publishTime) })}</span>
                </>
              )}
            </p>
          </header>

          {detail.description && (
            <div className="flex flex-col gap-[var(--sp-2)]">
              <h2 className="font-[family-name:var(--font-display)] text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
                {musicText('music.mv.about')}
              </h2>
              <p className="whitespace-pre-line text-[length:var(--text-13)] leading-relaxed text-[var(--text-secondary)]">
                {detail.description}
              </p>
            </div>
          )}

          <div>
            <Button variant="secondary" onClick={() => setVideoKey((value) => value + 1)}>
              {musicText('music.mv.reload_video')}
            </Button>
          </div>
        </>
      ) : (
        <Empty
          art="select"
          title={musicText('music.mv.detail_error')}
          description={musicText('music.mv.detail_empty_hint')}
        />
      )}
    </section>
  )
}

/** The stream route resolves a library track, so the provider's MV identity is saved before playback. */
async function ensureMvTrack(mv: MusicMvSummary): Promise<MusicTrack> {
  const input: MusicTrack = {
    id: '',
    provider: 'netease',
    providerId: mv.id,
    kind: 'mv',
    title: mv.name,
    artists: mv.artist ? [{ id: '', name: mv.artist }] : [],
    album: '',
    albumId: '',
    coverUrl: mv.coverUrl,
    coverKey: '',
    durationMs: mv.durationMs,
    format: 'mp4',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: 'original',
    createdAt: 0,
    updatedAt: 0,
  }
  const answer = await musicApi.upsertTracks([input])
  const track = answer.tracks[0]
  if (!track) throw new Error(musicText('music.mv.prepare_failed'))
  return track
}
