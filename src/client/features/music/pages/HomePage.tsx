/**
 * The discovery home: one hero for today's listening, a personal-radio card, then the shelves the
 * catalog is actually made of — playlists, new albums, new songs and artists.
 *
 * Logged-in state is read from the home answer itself (`fmEnabled` and a non-empty daily list) rather
 * than from a second account request: the provider already decided what this session may see, and a
 * second call could disagree with the feed on screen. A section with no rows is not drawn; when every
 * shelf is empty the page says so with one action instead of showing six empty headings.
 */
import { useId, useState, type ReactElement } from 'react'
import { ArrowUpRight, LogIn, Play, Radio } from 'lucide-react'
import { formatPlayCount } from '@shared/music/format'
import type { MusicAlbumSummary, MusicArtistSummary, MusicPlaylistSummary } from '@shared/music/api'
import { Button, Badge } from '../../../components/primitives'
import { Empty, Skeleton } from '../../../components/feedback'
import { useLocale } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { Cover } from '../components/Cover'
import { SectionHeader } from '../components/SectionHeader'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { DetailHeroSkeleton } from './parts/Hero'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { MusicPageBody, PageError, TrackListSkeleton, musicErrorMessage } from './parts/PageState'
import { playTracks } from './parts/playback'

/** Six to eight cards per shelf is what the spec asks for; more than that is a browse screen. */
const SHELF_LIMIT = 8
const TRACK_SHELF_LIMIT = 20

function releaseYear(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const year = new Date(value).getFullYear()
  return Number.isFinite(year) ? year : null
}

function playlistMeta(item: MusicPlaylistSummary): string {
  return item.creator || musicText('music.common.track_count', { count: item.trackCount })
}

function albumMeta(item: MusicAlbumSummary): string {
  const artists = item.artists.filter(Boolean).join(' / ')
  return artists || musicText('music.common.track_count', { count: item.trackCount })
}

function artistMeta(item: MusicArtistSummary, locale: string): string {
  return musicText('music.common.followers', { count: formatPlayCount(item.followCount, locale) })
}

function HomeSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <DetailHeroSkeleton />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <CardGridSkeleton />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <TrackListSkeleton />
      </div>
    </div>
  )
}

export function HomePage(): ReactElement {
  const toast = useUi((state) => state.toast)
  const locale = useLocale()
  const [fmBusy, setFmBusy] = useState(false)
  const playlistsId = useId()
  const albumsId = useId()
  const tracksId = useId()
  const artistsId = useId()
  const fmTitleId = useId()
  const connectTitleId = useId()
  const home = useMusicQuery(() => musicApi.home(), [])
  const data = home.data
  const daily = data?.dailyTracks ?? []
  const recommended = data?.recommendedPlaylists ?? []
  const albums = data?.newAlbums ?? []
  const artists = data?.hotArtists ?? []
  const newTracks = data?.newTracks ?? []
  const connected = Boolean(data?.fmEnabled)
  const hasContent = connected
    || daily.length > 0
    || recommended.length > 0
    || albums.length > 0
    || artists.length > 0
    || newTracks.length > 0
  const pageTitle = (
    <h1 className="music-section-header__title">{musicText('music.page.home')}</h1>
  )

  const startFm = async (): Promise<void> => {
    setFmBusy(true)
    try {
      const answer = await musicApi.fm()
      if (answer.tracks.length === 0) {
        toast({ title: musicText('music.home.fm.empty'), tone: 'warning' })
        return
      }
      playTracks(answer.tracks)
    } catch (error) {
      toast({
        title: musicText('music.home.fm.error'),
        description: musicErrorMessage(error),
        tone: 'danger',
      })
    } finally {
      setFmBusy(false)
    }
  }

  if (home.status === 'loading' && !data) {
    return (
      <MusicPageBody>
        {pageTitle}
        <HomeSkeleton />
      </MusicPageBody>
    )
  }

  if (home.status === 'error' && !data) {
    return (
      <MusicPageBody>
        {pageTitle}
        <PageError error={home.error} onRetry={home.reload} />
      </MusicPageBody>
    )
  }

  if (!data) {
    return (
      <MusicPageBody>
        {pageTitle}
        <PageError error={home.error} onRetry={home.reload} />
      </MusicPageBody>
    )
  }

  const dailyHero = daily.length > 0
  const featured = dailyHero ? null : recommended[0]
  const hero = dailyHero ? (
    <section className="music-hero" aria-label={musicText('music.home.daily.eyebrow')}>
      <Cover trackId={daily[0].id} size="xl" radius="lg" />
      <div className="music-hero__text">
        <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
          {musicText('music.home.daily.eyebrow')}
        </p>
        <h2 className="music-hero__title">{musicText('music.home.daily.title')}</h2>
        <p className="music-hero__description">
          {musicText('music.home.daily.description', { count: daily.length })}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="primary" icon={<Play size={14} />} onClick={() => playTracks(daily)}>
            {musicText('music.common.play_all')}
          </Button>
        </div>
      </div>
    </section>
  ) : featured ? (
    <section className="music-hero" aria-label={musicText('music.home.recommended.eyebrow')}>
      <Cover src={featured.coverUrl} size="xl" radius="lg" />
      <div className="music-hero__text">
        <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
          {musicText('music.home.recommended.eyebrow')}
        </p>
        <h2 className="music-hero__title">{featured.name}</h2>
        <p className="music-hero__description line-clamp-3">
          {featured.description || musicText('music.common.track_count', { count: featured.trackCount })}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="primary"
            icon={<ArrowUpRight size={14} />}
            onClick={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: featured.id }))}
          >
            {musicText('music.common.open')}
          </Button>
        </div>
      </div>
    </section>
  ) : null

  const aside = connected ? (
    <aside
      aria-labelledby={fmTitleId}
      className="flex flex-col justify-between gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-4 md:p-5"
    >
      <div className="flex flex-col gap-2">
        <span className="flex size-9 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <Radio size={16} aria-hidden="true" />
        </span>
        <h2
          id={fmTitleId}
          className="font-[family-name:var(--font-display)] text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]"
        >
          {musicText('music.home.fm.title')}
        </h2>
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {musicText('music.home.fm.description')}
        </p>
      </div>
      <Button
        variant="primary"
        icon={<Radio size={14} />}
        loading={fmBusy}
        onClick={() => {
          void startFm()
        }}
      >
        {musicText('music.home.fm.play')}
      </Button>
    </aside>
  ) : (
    <aside
      aria-labelledby={connectTitleId}
      className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] bg-[var(--bg-sunken)] p-4 md:flex-row md:items-center md:justify-between md:p-5"
    >
      <div className="min-w-0">
        <h2
          id={connectTitleId}
          className="text-[length:var(--text-13-5)] font-medium text-[var(--text-secondary)]"
        >
          {musicText('music.home.connect.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {musicText('music.home.connect.description')}
        </p>
      </div>
      <Button
        variant="secondary"
        icon={<LogIn size={14} />}
        onClick={() => navigateToAddress('/music/login')}
      >
        {musicText('music.home.connect.action')}
      </Button>
    </aside>
  )

  if (!hasContent) {
    return (
      <MusicPageBody>
        {pageTitle}
        <Empty
          art="search"
          title={musicText('music.home.empty.title')}
          description={musicText('music.home.empty.description')}
          action={(
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="secondary" onClick={() => home.reload()}>
                {musicText('music.common.retry')}
              </Button>
              <Button
                variant="primary"
                icon={<LogIn size={14} />}
                onClick={() => navigateToAddress('/music/login')}
              >
                {musicText('music.home.connect.action')}
              </Button>
            </div>
          )}
        />
      </MusicPageBody>
    )
  }

  return (
    <MusicPageBody>
      {pageTitle}

      {home.status === 'error' && (
        <PageError compact error={home.error} onRetry={home.reload} />
      )}

      {hero ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {hero}
          {aside}
        </div>
      ) : (
        aside
      )}

      {recommended.length > 0 && (
        <section aria-labelledby={playlistsId}>
          <SectionHeader id={playlistsId} title={musicText('music.home.section.playlists')} />
          <div className="music-card-grid">
            {recommended.slice(0, SHELF_LIMIT).map((item) => (
              <MusicCard
                key={item.id}
                coverSrc={item.coverUrl}
                title={item.name}
                meta={playlistMeta(item)}
                onOpen={() => navigateToAddress(musicPathFor({ kind: 'playlist', id: item.id }))}
              />
            ))}
          </div>
        </section>
      )}

      {albums.length > 0 && (
        <section aria-labelledby={albumsId}>
          <SectionHeader id={albumsId} title={musicText('music.home.section.new_albums')} />
          <div className="music-card-grid">
            {albums.slice(0, SHELF_LIMIT).map((item) => {
              const year = releaseYear(item.publishTime)
              return (
                <MusicCard
                  key={item.id}
                  coverSrc={item.coverUrl}
                  title={item.name}
                  meta={albumMeta(item)}
                  badge={year ? <Badge>{year}</Badge> : undefined}
                  onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: item.id }))}
                />
              )
            })}
          </div>
        </section>
      )}

      {newTracks.length > 0 && (
        <section aria-labelledby={tracksId}>
          <SectionHeader id={tracksId} title={musicText('music.home.section.new_tracks')} />
          <SongList
            tracks={newTracks.slice(0, TRACK_SHELF_LIMIT)}
            onPlay={(track, queue) => playTracks(queue, track)}
          />
        </section>
      )}

      {artists.length > 0 && (
        <section aria-labelledby={artistsId}>
          <SectionHeader id={artistsId} title={musicText('music.home.section.hot_artists')} />
          <div className="music-card-grid">
            {artists.slice(0, SHELF_LIMIT).map((item) => (
              <MusicCard
                key={item.id}
                coverSrc={item.coverUrl}
                title={item.name}
                meta={artistMeta(item, locale)}
                round
                onOpen={() => navigateToAddress(musicPathFor({ kind: 'artist', id: item.id }))}
              />
            ))}
          </div>
        </section>
      )}
    </MusicPageBody>
  )
}
