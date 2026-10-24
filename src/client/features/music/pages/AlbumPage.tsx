/**
 * One album: the release facts, the description the catalog sometimes has, and its tracks.
 *
 * Albums paginate like playlists because the provider answers in pages; the header keeps the facts
 * from the first answer while a later page is in flight, so the screen does not flash back to a
 * skeleton when the reader asks for the next page.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Play } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { useLocale } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { Pager } from '../components/Pager'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

const PAGE_SIZE = 50

export interface AlbumPageProps {
  id: string
}

export function AlbumPage({ id }: AlbumPageProps): ReactElement {
  const [page, setPage] = useState(1)
  const recentRecorded = useRef<string | null>(null)
  const locale = useLocale()
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale],
  )
  const query = useMusicQuery(
    () => musicApi.album(id, page, PAGE_SIZE),
    [id, page],
  )

  useEffect(() => {
    setPage(1)
  }, [id])

  const detail = query.data?.album.id === id ? query.data : null

  useEffect(() => {
    if (!detail || recentRecorded.current === detail.album.id) return
    recentRecorded.current = detail.album.id
    void useMusicLibrary.getState().touchRecent({
      kind: 'album',
      providerId: detail.album.id,
      name: detail.album.name,
      coverUrl: detail.album.coverUrl,
    })
  }, [detail?.album.id])

  if (!detail) {
    if (query.status === 'error') {
      return (
        <MusicPageBody>
          <PageError error={query.error} onRetry={query.reload} />
        </MusicPageBody>
      )
    }
    return (
      <MusicPageBody>
        <DetailHeroSkeleton />
        <TrackListSkeleton />
      </MusicPageBody>
    )
  }

  const album = detail.album
  const published = Number.isFinite(album.publishTime) && album.publishTime > 0
    ? dateFormatter.format(new Date(album.publishTime))
    : null
  const pageCount = Math.max(1, Math.ceil(detail.total / PAGE_SIZE))
  const meta = (
    <>
      {album.artists.length > 0 && <span>{album.artists.join(' / ')}</span>}
      {published && <span>{musicText('music.album.released', { date: published })}</span>}
      <span>{musicText('music.common.track_count', { count: album.trackCount })}</span>
    </>
  )

  return (
    <MusicPageBody>
      {query.status === 'error' && (
        <PageError compact error={query.error} onRetry={query.reload} />
      )}

      <DetailHero
        key={id}
        coverSrc={album.coverUrl}
        eyebrow={musicText('music.album.eyebrow')}
        title={album.name}
        meta={meta}
        description={detail.description}
        actions={(
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={detail.tracks.length === 0}
            onClick={() => playTracks(detail.tracks)}
          >
            {musicText('music.common.play_all')}
          </Button>
        )}
      />

      <SongList
        tracks={detail.tracks}
        loading={query.status === 'loading'}
        onPlay={(track, queue) => playTracks(queue, track)}
        emptyAction={(
          <Button size="sm" variant="secondary" onClick={() => navigateToAddress('/music')}>
            {musicText('music.common.discover')}
          </Button>
        )}
      />

      <Pager page={page} pageCount={pageCount} onChange={setPage} />
    </MusicPageBody>
  )
}
