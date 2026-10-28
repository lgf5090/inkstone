/**
 * The foot of an immersive pane: what plays, where it is, and the controls.
 *
 * The stage and the wall take the whole layer, so they cannot borrow the sidebar's transport. This bar
 * is deliberately one row tall on a desktop and two on a phone, keeping the artwork and the controls
 * within a thumb's reach.
 */
import type { ReactElement } from 'react'
import { musicArtistNames } from '@shared/music/format'
import { Cover } from '../components/Cover'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { NowPlayingScrubber } from './Scrubber'
import { NowPlayingTransport } from './NowPlayingTransport'

export function NowPlayingSlimBar(): ReactElement | null {
  const current = useMusicPlayer(selectCurrentTrack)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const seek = useMusicPlayer((state) => state.seek)
  if (!current) return null
  return (
    <div className="music-np__slim">
      <NowPlayingScrubber
        compact
        positionMs={positionMs}
        durationMs={durationMs || current.durationMs}
        onSeek={seek}
      />
      <div className="music-np__slim-row">
        <Cover
          trackId={current.id}
          src={current.coverUrl || undefined}
          version={current.updatedAt}
          size="sm"
          radius="sm"
          className="music-np__slim-cover"
        />
        <span className="music-np__slim-text">
          <span className="music-np__slim-title" title={current.title}>{current.title}</span>
          <span className="music-np__slim-artist">{musicArtistNames(current)}</span>
        </span>
        <NowPlayingTransport compact />
      </div>
    </div>
  )
}
