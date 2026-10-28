/**
 * The queue pane of Now Playing, shared with the full-screen layer.
 *
 * The rows are the player's own tracks rather than a second queue store: pressing one moves the same
 * queue the bar walks, and the active row is marked with `aria-current`.
 */
import type { ReactElement } from 'react'
import { ListMusic } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { Cover } from '../components/Cover'
import { musicText } from '../components/labels'
import { useMusicPlayer } from '../store/player'

export function QueuePane(): ReactElement {
  const queue = useMusicPlayer((state) => state.queue)
  const playTrack = useMusicPlayer((state) => state.playTrack)
  if (queue.tracks.length === 0) {
    return (
      <div className="music-np__pane-body music-np__empty">
        <ListMusic size={24} aria-hidden="true" />
        <p>{musicText('music.queue.empty')}</p>
      </div>
    )
  }
  return (
    <ol className="music-np__pane-body music-queue music-np__queue" aria-label={musicText('music.queue.title')}>
      {queue.tracks.map((track, index) => {
        const active = index === queue.index
        return (
          <li key={track.id} className="music-queue__row" data-active={active || undefined}>
            <button
              type="button"
              className="music-queue__main"
              aria-current={active ? 'true' : undefined}
              onClick={() => { void playTrack(track) }}
            >
              <Cover trackId={track.id} src={track.coverUrl || undefined} version={track.updatedAt} size="sm" radius="sm" />
              <span className="music-queue__text">
                <span className="music-queue__title">{track.title}</span>
                <span className="music-queue__meta">{musicArtistNames(track)}</span>
              </span>
              <span className="music-queue__duration">{formatDuration(track.durationMs)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
