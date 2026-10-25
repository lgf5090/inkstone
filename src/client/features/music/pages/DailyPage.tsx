/**
 * Today's recommendation list, opened from the discovery hero.
 *
 * The hero only has room for one cover and a Play button; the reader who wants to choose a song
 * lands here. It reads the same daily endpoint the hero summarises, so both screens agree on the
 * list and the page can be deep-linked like any other collection.
 */
import { Play } from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '../../../components/primitives'
import { musicApi } from '../api'
import { SongList } from '../components/SongList'
import { musicText } from '../components/labels'
import { useMusicQuery } from '../query'
import { DetailHero, DetailHeroSkeleton } from './parts/Hero'
import { MusicPageBody, PageError, TrackListSkeleton } from './parts/PageState'
import { playTracks } from './parts/playback'

export function DailyPage(): ReactElement {
  const daily = useMusicQuery(() => musicApi.daily().then((answer) => answer.tracks), [])
  const tracks = daily.data ?? []

  if (!daily.data) {
    if (daily.status === 'error') {
      return (
        <MusicPageBody>
          <PageError error={daily.error} onRetry={daily.reload} />
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

  return (
    <MusicPageBody>
      {daily.status === 'error' && <PageError compact error={daily.error} onRetry={daily.reload} />}

      <DetailHero
        coverSrc={tracks[0]?.coverUrl || undefined}
        eyebrow={musicText('music.home.daily.eyebrow')}
        title={musicText('music.home.daily.title')}
        meta={<span>{musicText('music.common.track_count', { count: tracks.length })}</span>}
        description={musicText('music.daily.description')}
        actions={(
          <Button
            variant="primary"
            icon={<Play size={14} />}
            disabled={tracks.length === 0}
            onClick={() => playTracks(tracks)}
          >
            {musicText('music.common.play_all')}
          </Button>
        )}
      />

      <SongList
        tracks={tracks}
        loading={daily.status === 'loading'}
        onPlay={(track, queue) => playTracks(queue, track)}
      />
    </MusicPageBody>
  )
}
