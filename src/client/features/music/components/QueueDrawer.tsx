/**
 * The playback queue, in the shared right-hand drawer.
 *
 * Rows keep the drawer's own shape rather than reusing `SongRow`: this list is about position, so it
 * carries move and remove controls that a library row does not, and it has no favourite or overflow
 * menu to offer. The current row is tinted with the accent wash and its title switches to the accent
 * text colour, the same "current" signal the rows use.
 *
 * Reordering writes the queue through the store's public state. It deliberately does not call
 * `setQueue`: that builds a new queue and stops the audio element, while a move only changes slots.
 * The current track keeps sounding, its index is recomputed by id, and the snapshot written on
 * `pagehide` persists the new order.
 */
import type { ReactElement } from 'react'
import { ChevronDown, ChevronUp, ListMusic, X } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import { Button, IconButton } from '../../../components/primitives'
import { Drawer } from '../../../components/overlay'
import { Empty } from '../../../components/feedback'
import { navigateToAddress } from '../../../lib/app-history'
import { useMusicPlayer } from '../store/player'
import { useMusicUi } from '../store/ui'
import { Cover } from './Cover'
import { musicText } from './labels'

/** Swap one entry with its neighbour, keeping every other position. */
function moveWithin(list: readonly MusicTrack[], trackId: string, offset: number): MusicTrack[] {
  const from = list.findIndex((track) => track.id === trackId)
  const to = from + offset
  if (from < 0 || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (!moved) return next
  next.splice(to, 0, moved)
  return next
}

function moveQueueTrack(trackId: string, offset: number): void {
  const state = useMusicPlayer.getState()
  const { tracks, original, index } = state.queue
  const from = tracks.findIndex((track) => track.id === trackId)
  const to = from + offset
  if (from < 0 || to < 0 || to >= tracks.length) return
  const currentId = tracks[index]?.id
  const nextTracks = moveWithin(tracks, trackId, offset)
  const nextIndex = currentId ? nextTracks.findIndex((track) => track.id === currentId) : 0
  useMusicPlayer.setState({
    queue: {
      ...state.queue,
      tracks: nextTracks,
      index: nextIndex < 0 ? 0 : nextIndex,
      // Shuffle keeps the pre-shuffle order beside the walking order; both have to agree on the move.
      original: original ? moveWithin(original, trackId, offset) : null,
    },
  })
}

export function QueueDrawer(): ReactElement {
  const open = useMusicUi((state) => state.queueOpen)
  const setQueueOpen = useMusicUi((state) => state.setQueueOpen)
  const queue = useMusicPlayer((state) => state.queue)
  const playTrack = useMusicPlayer((state) => state.playTrack)
  const removeFromQueue = useMusicPlayer((state) => state.removeFromQueue)

  const close = (): void => setQueueOpen(false)
  const discover = (): void => {
    setQueueOpen(false)
    navigateToAddress('/music')
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      side="right"
      width={320}
      title={musicText('music.queue.title')}
    >
      {queue.tracks.length === 0 ? (
        <Empty
          art="notes"
          compact
          title={musicText('music.queue.empty')}
          description={musicText('music.queue.empty_hint')}
          action={
            <Button variant="secondary" size="sm" onClick={discover}>
              {musicText('music.queue.discover')}
            </Button>
          }
        />
      ) : (
        <ol className="music-queue" aria-label={musicText('music.queue.title')}>
          {queue.tracks.map((track, index) => {
            const active = index === queue.index
            return (
              <li key={track.id} className="music-queue__row" data-active={active || undefined}>
                <button
                  type="button"
                  className="music-queue__main"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    void playTrack(track)
                  }}
                >
                  <Cover trackId={track.id} src={track.coverUrl || undefined} size="sm" radius="sm" />
                  <span className="music-queue__text">
                    <span className="music-queue__title">{track.title}</span>
                    <span className="music-queue__meta">{musicArtistNames(track)}</span>
                  </span>
                  <span className="music-queue__duration">{formatDuration(track.durationMs)}</span>
                </button>
                <span className="music-queue__actions">
                  <IconButton
                    label={musicText('music.queue.move_up')}
                    size="xs"
                    disabled={index === 0}
                    onClick={() => moveQueueTrack(track.id, -1)}
                  >
                    <ChevronUp size={13} />
                  </IconButton>
                  <IconButton
                    label={musicText('music.queue.move_down')}
                    size="xs"
                    disabled={index === queue.tracks.length - 1}
                    onClick={() => moveQueueTrack(track.id, 1)}
                  >
                    <ChevronDown size={13} />
                  </IconButton>
                  <IconButton
                    label={musicText('music.queue.remove')}
                    size="xs"
                    onClick={() => {
                      void removeFromQueue(track.id)
                    }}
                  >
                    <X size={13} />
                  </IconButton>
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {queue.tracks.length > 0 && (
        <p className="music-queue__footer">
          <ListMusic size={13} aria-hidden="true" />
          <span>{musicText('music.queue.count', { count: queue.tracks.length })}</span>
        </p>
      )}
    </Drawer>
  )
}
