/**
 * One artist: portrait, the numbers that identify them, the biography, and two views of the work.
 *
 * Songs are the provider's 50-row hot prefix; albums are paged separately because the detail answer
 * only carries the first shelf. Switching tabs does not refetch the artist — the header stays put —
 * and an album page keeps its own index so coming back to the tab returns to the shelf it left.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Play } from 'lucide-react'
import { formatPlayCount } from '@shared/music/format'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { useLocale } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { MusicTabs } from '../components/Tabs'
import { Pager } from '../components/Pager'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

const ALBUM_PAGE_SIZE = 30

type ArtistTab = 'songs' | 'albums'

export interface ArtistPageProps {
  id: string
}

export function ArtistPage({ id }: ArtistPageProps): ReactElement {
  const [tab, setTab] = useState<ArtistTab>('songs')
  const [albumPage, setAlbumPage] = useState(1)
  const locale = useLocale()
  const detailQuery = useMusicQuery(() => musicApi.artist(id), [id])
  const albumsQuery = useMusicQuery(
    () => musicApi.artistAlbums(id, albumPage, ALBUM_PAGE_SIZE),
    [id, albumPage],
    { enabled: tab === 'albums' },
  )

  useEffect(() => {
    setTab('songs')
    setAlbumPage(1)
  }, [id])

  const detail = detailQuery.data?.artist.id === id ? detailQuery.data : null

  if (!detail) {
    if (detailQuery.status === 'error') {
      return (
        <MusicPageBody>
          <PageError error={detailQuery.error} onRetry={detailQuery.reload} />
        </MusicPageBody>
      )
    }
    return (
      <MusicPageBody>
        <DetailHeroSkeleton round />
        <TrackListSkeleton />
      </MusicPageBody>
    )
  }

  const artist = detail.artist
  const hotTracks = detail.hotTracks
  const albums = albumsQuery.data?.items ?? []
  const albumTotal = albumsQuery.data?.total ?? artist.albumCount
  const albumPageCount = Math.max(1, Math.ceil(albumTotal / ALBUM_PAGE_SIZE))
  const meta = (
    <>
      <span>
        {musicText('music.common.followers', {
          count: formatPlayCount(artist.followCount, locale),
        })}
      </span>
      <span>{musicText('music.common.albums', { count: artist.albumCount })}</span>
    </>
  )

  return (
    <MusicPageBody>
      {detailQuery.status === 'error' && (
        <PageError compact error={detailQuery.error} onRetry={detailQuery.reload} />
      )}

      <DetailHero
        key={id}
        coverSrc={artist.coverUrl}
        coverShape="round"
        eyebrow={musicText('music.artist.eyebrow')}
        title={artist.name}
        meta={meta}
        description={detail.description}
        actions={(
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={hotTracks.length === 0}
            onClick={() => playTracks(hotTracks)}
          >
            {musicText('music.common.play_all')}
          </Button>
        )}
      />

      <MusicTabs<ArtistTab>
        value={tab}
        items={[
          {
            value: 'songs',
            label: musicText('music.artist.tab.songs'),
            count: tab === 'songs' ? hotTracks.length : undefined,
          },
          {
            value: 'albums',
            label: musicText('music.artist.tab.albums'),
            count: tab === 'albums' ? albumTotal : undefined,
          },
        ]}
        onChange={(next) => {
          setTab(next)
          setAlbumPage(1)
        }}
        label={musicText('music.artist.tabs.label')}
      />

      {tab === 'songs' ? (
        <section aria-label={musicText('music.artist.tab.songs')}>
          {hotTracks.length === 0 ? (
            <Empty
              art="search"
              title={musicText('music.artist.empty_songs.title')}
              description={musicText('music.artist.empty_songs.description')}
              action={(
                <Button size="sm" variant="secondary" onClick={() => navigateToAddress('/music')}>
                  {musicText('music.common.discover')}
                </Button>
              )}
            />
          ) : (
            <SongList
              tracks={hotTracks}
              onPlay={(track, queue) => playTracks(queue, track)}
            />
          )}
        </section>
      ) : (
        <section aria-label={musicText('music.artist.tab.albums')}>
          {albumsQuery.status === 'idle' || albumsQuery.status === 'loading' ? (
            <CardGridSkeleton />
          ) : albumsQuery.status === 'error' && !albumsQuery.data ? (
            <PageError compact error={albumsQuery.error} onRetry={albumsQuery.reload} />
          ) : albums.length === 0 ? (
            <Empty
              art="folder"
              title={musicText('music.artist.empty_albums.title')}
              description={musicText('music.artist.empty_albums.description')}
              action={(
                <Button size="sm" variant="secondary" onClick={() => navigateToAddress('/music')}>
                  {musicText('music.common.discover')}
                </Button>
              )}
            />
          ) : (
            <>
              {albumsQuery.status === 'error' && (
                <PageError compact error={albumsQuery.error} onRetry={albumsQuery.reload} />
              )}
              <div className="music-card-grid">
                {albums.map((item) => (
                  <MusicCard
                    key={item.id}
                    coverSrc={item.coverUrl}
                    title={item.name}
                    meta={musicText('music.common.track_count', { count: item.trackCount })}
                    onOpen={() => navigateToAddress(musicPathFor({ kind: 'album', id: item.id }))}
                  />
                ))}
              </div>
              <Pager page={albumPage} pageCount={albumPageCount} onChange={setAlbumPage} />
            </>
          )}
        </section>
      )}
    </MusicPageBody>
  )
}
