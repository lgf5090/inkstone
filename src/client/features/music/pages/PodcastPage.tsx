/** Podcasts and radio: a card list, a show page with its episodes, and subscription state. */
import { useEffect, useId, useState, type ReactElement } from 'react'
import { Bell, BellOff, ChevronLeft } from 'lucide-react'
import { formatPlayCount } from '@shared/music/format'
import type { MusicPlaylistSummary, MusicRadioSummary } from '@shared/music/api'
import type { MusicTrack } from '@shared/music/model'
import { Empty } from '../../../components/feedback'
import { Button } from '../../../components/primitives'
import { musicApi } from '../api'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { useMusicUi } from '../store/ui'
import { useUi } from '../../../store/ui'
import { Cover } from '../components/Cover'
import { Pager } from '../components/Pager'
import { SectionHeader } from '../components/SectionHeader'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { MediaCard, MediaGridSkeleton } from './parts/P2MediaCard'
import {
  PAGE_STACK,
  QueryError,
  formatCount,
  onMusicLink,
  toastFailure,
} from './parts/P2QueryState'

const PAGE_SIZE = 30

export function PodcastPage(): ReactElement {
  const page = useMusicUi((state) => state.page)
  if (page.kind === 'podcastDetail') return <PodcastDetailPage key={page.id} id={page.id} />
  return <PodcastListPage />
}

function PodcastListPage(): ReactElement {
  const [pageIndex, setPageIndex] = useState(1)
  const headingId = useId()
  const query = useMusicQuery(() => musicApi.radios(pageIndex, PAGE_SIZE), [pageIndex])
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader
        level={1}
        id={headingId}
        title={musicText('music.page.podcast')}
        description={musicText('music.podcast.list_description')}
      />

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.podcast.error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
        <MediaGridSkeleton count={10} />
      ) : items.length === 0 ? (
        <Empty
          art="subscriptions"
          title={musicText('music.podcast.empty')}
          description={musicText('music.podcast.empty_hint')}
        />
      ) : (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.podcast.error')} detail={query.error} onRetry={query.reload} />
          )}
          <div className="music-card-grid">
            {items.map((item) => (
              <PodcastCard key={item.id} item={item} />
            ))}
          </div>
          <Pager page={pageIndex} pageCount={pageCount} onChange={setPageIndex} />
        </>
      )}
    </section>
  )
}

function PodcastCard({ item }: { item: MusicPlaylistSummary }): ReactElement {
  // The discovery route is typed as a playlist page while its provider answers with radio rows;
  // read the radio count when it is present and keep the playlist count as the older fallback.
  const radio = item as unknown as Partial<MusicRadioSummary>
  const programCount = typeof radio.programCount === 'number' ? radio.programCount : item.trackCount
  const meta = programCount > 0
    ? musicText('music.podcast.program_count', { count: programCount })
    : item.creator || ''
  return (
    <MediaCard
      href={musicPathFor({ kind: 'podcastDetail', id: item.id })}
      title={item.name}
      meta={meta}
      description={item.description}
      coverUrl={item.coverUrl}
    />
  )
}

function PodcastDetailPage({ id }: { id: string }): ReactElement {
  const [pageIndex, setPageIndex] = useState(1)
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const query = useMusicQuery(async () => {
    const [detail, subscriptions] = await Promise.all([
      musicApi.radio(id, pageIndex, PAGE_SIZE),
      musicApi.subscriptions(),
    ])
    return { detail, subscriptions }
  }, [id, pageIndex])

  useEffect(() => {
    setSubscribed(null)
  }, [id])

  const radio = query.data?.detail.radio
  const programs = query.data?.detail.programs ?? []
  const total = query.data?.detail.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isSubscribed = subscribed ?? Boolean(
    radio && query.data?.subscriptions.items.some(
      (entry) => entry.kind === 'radio' && entry.providerId === radio.id,
    ),
  )

  const toggleSubscription = async (): Promise<void> => {
    if (!radio) return
    const next = !isSubscribed
    setSaving(true)
    try {
      await musicApi.subscribeRadio(radio.id, next)
      setSubscribed(next)
      useUi.getState().toast({
        title: musicText(
          next ? 'music.podcast.subscribed_toast' : 'music.podcast.unsubscribed_toast',
          { name: radio.name },
        ),
        tone: 'success',
      })
    } catch (error) {
      toastFailure(musicText('music.podcast.subscribe_failed'), error)
    } finally {
      setSaving(false)
    }
  }

  const playProgram = (track: MusicTrack, queue: readonly MusicTrack[]): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
    void useMusicLibrary.getState().recordHistory({ track, contextType: 'radio', contextId: id })
    if (radio) {
      void useMusicLibrary.getState().touchRecent({
        kind: 'radio',
        providerId: radio.id,
        name: radio.name,
        coverUrl: radio.coverUrl,
      })
    }
  }

  const backHref = musicPathFor({ kind: 'podcast' })

  return (
    <section aria-label={musicText('music.page.podcast_detail')} className={PAGE_STACK}>
      <div>
        <a
          href={backHref}
          onClick={(event) => onMusicLink(event, backHref)}
          className="inline-flex items-center gap-[var(--sp-1)] rounded-[var(--r-sm)] text-[length:var(--text-12)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {musicText('music.podcast.back')}
        </a>
      </div>

      {query.status === 'error' && !query.data ? (
        <QueryError
          title={musicText('music.podcast.detail_error')}
          detail={query.error}
          onRetry={query.reload}
        />
      ) : query.status === 'loading' && !query.data ? (
        <div className="flex flex-col gap-[var(--sp-4)]" role="status" aria-busy="true" aria-label={musicText('common.loading')}>
          <div className="music-hero">
            <div className="size-[160px] rounded-[var(--r-lg)] bg-[var(--bg-sunken)]" />
            <div className="flex flex-1 flex-col gap-[var(--sp-3)]">
              <div className="h-[24px] w-2/3 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
              <div className="h-[12px] w-1/2 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]" />
              <div className="h-[32px] w-32 rounded-[var(--r-md)] bg-[var(--bg-sunken)]" />
            </div>
          </div>
          <SongList loading onPlay={() => undefined} />
        </div>
      ) : radio ? (
        <>
          {query.status === 'error' && (
            <QueryError title={musicText('music.podcast.detail_error')} detail={query.error} onRetry={query.reload} />
          )}

          <header className="music-hero">
            <Cover src={radio.coverUrl || undefined} size="lg" radius="lg" />
            <div className="music-hero__text">
              <h1 className="music-hero__title">{radio.name}</h1>
              {radio.description && (
                <p className="music-hero__description line-clamp-4">{radio.description}</p>
              )}
              <p className="flex flex-wrap items-center gap-[var(--sp-2)] text-[length:var(--text-11-5)] tabular text-[var(--text-tertiary)]">
                <span>{musicText('music.podcast.program_count', { count: total || radio.programCount })}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {musicText('music.podcast.subscriber_count', {
                    count: formatPlayCount(radio.subscriberCount),
                  })}
                </span>
              </p>
              <div>
                <Button
                  variant={isSubscribed ? 'secondary' : 'primary'}
                  loading={saving}
                  icon={isSubscribed ? <BellOff size={14} /> : <Bell size={14} />}
                  onClick={() => {
                    void toggleSubscription()
                  }}
                >
                  {musicText(isSubscribed ? 'music.podcast.unsubscribe' : 'music.podcast.subscribe')}
                </Button>
              </div>
            </div>
          </header>

          <section aria-label={musicText('music.podcast.programs')} className="flex flex-col gap-[var(--sp-3)]">
            <SectionHeader
              title={musicText('music.podcast.programs')}
              description={musicText('music.podcast.program_total', { count: formatCount(total) })}
            />
            {programs.length === 0 ? (
              <Empty
                art="subscriptions"
                compact
                title={musicText('music.podcast.no_programs')}
                description={musicText('music.podcast.no_programs_hint')}
              />
            ) : (
              <>
                <SongList
                  tracks={programs}
                  loading={query.status === 'loading'}
                  onPlay={playProgram}
                />
                <Pager page={pageIndex} pageCount={pageCount} onChange={setPageIndex} />
              </>
            )}
          </section>
        </>
      ) : (
        <Empty
          art="select"
          title={musicText('music.podcast.detail_error')}
          description={musicText('music.podcast.detail_empty_hint')}
        />
      )}
    </section>
  )
}
