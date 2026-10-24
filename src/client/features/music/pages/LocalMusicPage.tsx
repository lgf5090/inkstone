/** The tracks this deployment owns: uploads first, then remote WebDAV references, as real library rows. */
import { useId, type ReactElement } from 'react'
import type { MusicTrack } from '@shared/music/model'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { useMusicPlayer } from '../store/player'
import { SongList } from '../components/SongList'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import { PageError } from './parts/PageState'
import { PAGE_STACK } from './parts/P2QueryState'

export function LocalMusicPage(): ReactElement {
  const headingId = useId()
  const query = useMusicQuery(async () => {
    const [uploads, webdav] = await Promise.all([
      musicApi.tracks('upload'),
      musicApi.tracks('webdav'),
    ])
    return [...uploads.items, ...webdav.items]
  }, [])
  const tracks = query.data ?? []
  const play = (track: MusicTrack, queue: readonly MusicTrack[]): void => {
    void useMusicPlayer.getState().playTrack(track, { queue })
  }
  return (
    <section aria-labelledby={headingId} className={PAGE_STACK}>
      <SectionHeader
        level={1}
        id={headingId}
        title={musicText('music.page.local')}
        description={musicText('music.local.description', { count: tracks.length })}
        action={{ label: musicText('music.cloud.manage_uploads'), onClick: () => navigateToAddress('/music/uploads') }}
      />
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <SongList loading onPlay={() => undefined} /> : tracks.length === 0 ? (
        <Empty
          art="folder"
          title={musicText('music.local.empty')}
          description={musicText('music.local.empty_hint')}
          action={<Button variant="primary" onClick={() => navigateToAddress('/music/uploads')}>{musicText('music.cloud.manage_uploads')}</Button>}
        />
      ) : (
        <SongList tracks={tracks} onPlay={play} />
      )}
    </section>
  )
}
