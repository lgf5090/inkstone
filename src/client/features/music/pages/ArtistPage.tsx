/**
 * One artist: portrait, the numbers that identify them, the biography, and four views of the work.
 *
 * Songs are the provider's 50-row hot prefix; latest asks for the same artist ordered by release
 * time; albums are paged separately because the detail answer only carries the first shelf; events
 * are the artist's own account feed. Following is optimistic and rolls back on a refusal, including
 * the one that means no provider account is connected.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Play, UserCheck, UserPlus } from 'lucide-react'
import { formatPlayCount } from '@shared/music/format'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { ApiError } from '../../../lib/api'
import { useLocale } from '../../../lib/i18n'
import { navigateToAddress } from '../../../lib/app-history'
import { useUi } from '../../../store/ui'
import { musicApi } from '../api'
import { MusicTabs } from '../components/Tabs'
import { Pager } from '../components/Pager'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { musicPathFor } from '../music-address'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { ArtistEvents } from './parts/ArtistEvents'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { CardGridSkeleton, MusicCard } from './parts/MediaCards'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { toastFailure } from './parts/P2QueryState'
import { playTracks } from './parts/playback'

const ALBUM_PAGE_SIZE = 30
const LATEST_LIMIT = 100

type ArtistTab = 'songs' | 'latest' | 'albums' | 'events'

export interface ArtistPageProps {
  id: string
}

export function ArtistPage({ id }: ArtistPageProps): ReactElement {
  const [tab, setTab] = useState<ArtistTab>('songs')
  const [albumPage, setAlbumPage] = useState(1)
  const [followed, setFollowed] = useState<boolean | null>(null)
  const [followBusy, setFollowBusy] = useState(false)
  const recentRecorded = useRef<string | null>(null)
  const locale = useLocale()
  const detailQuery = useMusicQuery(() => musicApi.artist(id), [id])
  const albumsQuery = useMusicQuery(
    () => musicApi.artistAlbums(id, albumPage, ALBUM_PAGE_SIZE),
    [id, albumPage],
    { enabled: tab === 'albums' },
  )
  const latestQuery = useMusicQuery(
    () => musicApi.artistSongs(id, 1, LATEST_LIMIT, 'time'),
    [id],
    { enabled: tab === 'latest' },
  )

  useEffect(() => {
    setTab('songs')
    setAlbumPage(1)
    setFollowed(null)
    setFollowBusy(false)
  }, [id])

  const detail = detailQuery.data?.artist.id === id ? detailQuery.data : null

  useEffect(() => {
    if (!detail || recentRecorded.current === detail.artist.id) return
    recentRecorded.current = detail.artist.id
    void useMusicLibrary.getState().touchRecent({
      kind: 'artist',
      providerId: detail.artist.id,
      name: detail.artist.name,
      coverUrl: detail.artist.coverUrl,
    })
  }, [detail?.artist.id])

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
  const latestTracks = latestQuery.data?.items ?? []
  const albums = albumsQuery.data?.items ?? []
  const albumTotal = albumsQuery.data?.total ?? artist.albumCount
  const albumPageCount = Math.max(1, Math.ceil(albumTotal / ALBUM_PAGE_SIZE))
  const isFollowed = followed ?? detail.followed

  const toggleFollow = async (): Promise<void> => {
    if (followBusy) return
    const next = !isFollowed
    setFollowed(next)
    setFollowBusy(true)
    try {
      const answer = await musicApi.artistFollow(id, next)
      setFollowed(answer.followed)
      useUi.getState().toast({
        title: musicText(
          answer.followed ? 'music.artist.followed_toast' : 'music.artist.unfollowed_toast',
          { name: artist.name },
        ),
        tone: 'success',
      })
    } catch (reason: unknown) {
      setFollowed(!next)
      if (reason instanceof ApiError && reason.code === 'music_provider_auth_required') {
        useUi.getState().toast({
          title: musicText('music.artist.follow_login'),
          tone: 'danger',
        })
        navigateToAddress('/music/login')
      } else {
        toastFailure(musicText('music.artist.follow_failed'), reason)
      }
    } finally {
      setFollowBusy(false)
    }
  }

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
          <>
            <Button
              variant="primary"
              icon={<Play size={14} />}
              disabled={hotTracks.length === 0}
              onClick={() => playTracks(hotTracks)}
            >
              {musicText('music.common.play_all')}
            </Button>
            <Button
              variant={isFollowed ? 'secondary' : 'primary'}
              icon={isFollowed ? <UserCheck size={14} /> : <UserPlus size={14} />}
              loading={followBusy}
              aria-pressed={isFollowed}
              onClick={() => {
                void toggleFollow()
              }}
            >
              {musicText(isFollowed ? 'music.artist.following' : 'music.artist.follow')}
            </Button>
          </>
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
            value: 'latest',
            label: musicText('music.artist.tab.latest'),
            count: tab === 'latest' && latestQuery.status === 'ready' ? latestTracks.length : undefined,
          },
          {
            value: 'albums',
            label: musicText('music.artist.tab.albums'),
            count: tab === 'albums' ? albumTotal : undefined,
          },
          {
            value: 'events',
            label: musicText('music.artist.tab.events'),
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
      ) : tab === 'latest' ? (
        <section aria-label={musicText('music.artist.tab.latest')}>
          {latestQuery.status === 'idle' || latestQuery.status === 'loading' ? (
            <TrackListSkeleton />
          ) : latestQuery.status === 'error' && !latestQuery.data ? (
            <PageError compact error={latestQuery.error} onRetry={latestQuery.reload} />
          ) : latestTracks.length === 0 ? (
            <Empty
              art="search"
              title={musicText('music.artist.empty_latest.title')}
              description={musicText('music.artist.empty_latest.description')}
            />
          ) : (
            <>
              {latestQuery.status === 'error' && (
                <PageError compact error={latestQuery.error} onRetry={latestQuery.reload} />
              )}
              <SongList
                tracks={latestTracks}
                onPlay={(track, queue) => playTracks(queue, track)}
              />
            </>
          )}
        </section>
      ) : tab === 'events' ? (
        <section aria-label={musicText('music.artist.tab.events')}>
          <ArtistEvents artistId={id} />
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
