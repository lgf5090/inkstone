/** The tracks this deployment owns: uploads first, then remote WebDAV references, as real library rows. */
import { useId, useState, type ReactElement } from 'react'
import { formatBytes, formatDuration } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { Clock3, HardDrive, Music } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { Empty } from '../../../components/feedback'
import { navigateToAddress } from '../../../lib/app-history'
import { musicApi } from '../api'
import { useMusicQuery } from '../query'
import { useMusicLibrary } from '../store/library'
import { useMusicPlayer } from '../store/player'
import { SongList } from '../components/SongList'
import { EditTrackDialog } from '../components/EditTrackDialog'
import { M3UActions } from '../components/M3UActions'
import { MusicStatCard } from './parts/StatCard'
import { SectionHeader } from '../components/SectionHeader'
import { musicText } from '../components/labels'
import { PageError } from './parts/PageState'
import { PAGE_STACK } from './parts/P2QueryState'

export function LocalMusicPage(): ReactElement {
  const headingId = useId()
  const [editing, setEditing] = useState<MusicTrack | null>(null)
  const query = useMusicQuery(async () => {
    const [uploads, webdav] = await Promise.all([
      musicApi.tracks('upload'),
      musicApi.tracks('webdav'),
    ])
    return [...uploads.items, ...webdav.items]
  }, [])
  const tracks = query.data ?? []
  const totalDuration = tracks.reduce((sum, track) => sum + track.durationMs, 0)
  const totalSize = tracks.reduce((sum, track) => sum + (track.size ?? 0), 0)
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
      />
      <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
        <M3UActions tracks={tracks} />
        <Button variant="secondary" size="sm" onClick={() => navigateToAddress('/music/uploads')}>
          {musicText('music.cloud.manage_uploads')}
        </Button>
      </div>
      {tracks.length > 0 && (
        <div className="grid gap-[var(--sp-3)] sm:grid-cols-3">
          <MusicStatCard icon={<Music size={16} aria-hidden="true" />} label={musicText('music.local.stats.songs')} value={String(tracks.length)} />
          <MusicStatCard icon={<Clock3 size={16} aria-hidden="true" />} label={musicText('music.local.stats.duration')} value={formatDuration(totalDuration)} />
          <MusicStatCard icon={<HardDrive size={16} aria-hidden="true" />} label={musicText('music.local.stats.size')} value={formatBytes(totalSize)} />
        </div>
      )}
      {query.status === 'error' && !query.data ? <PageError error={query.error} onRetry={query.reload} /> : query.status === 'loading' && !query.data ? <SongList loading onPlay={() => undefined} /> : tracks.length === 0 ? (
        <Empty
          art="folder"
          title={musicText('music.local.empty')}
          description={musicText('music.local.empty_hint')}
          action={<Button variant="primary" onClick={() => navigateToAddress('/music/uploads')}>{musicText('music.cloud.manage_uploads')}</Button>}
        />
      ) : (
        <SongList tracks={tracks} onPlay={play} onEditTrack={setEditing} />
      )}
      <EditTrackDialog
        track={editing}
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          query.reload()
          void useMusicLibrary.getState().load()
        }}
      />
    </section>
  )
}
