/**
 * The phone-sized transport: artwork, title and the two presses a thumb needs.
 *
 * It is mounted instead of the desktop bar on a narrow shell (the stylesheet keeps it hidden above
 * the phone breakpoint, so a shell that renders both never shows two bars). The body is one button
 * that asks the shell to expand the full-screen layer; the play and next controls sit beside it so
 * neither gesture swallows the other.
 */
import type { ReactElement } from 'react'
import { ChevronUp, Pause, Play, SkipForward } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { IconButton } from '../../../components/primitives'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { Cover } from './Cover'
import { musicText } from './labels'

export interface MiniPlayerProps {
  /** Opens the full-screen surface. The shell owns how (a route, a modal, a sheet). */
  onExpand: () => void
}

export function MiniPlayer({ onExpand }: MiniPlayerProps): ReactElement | null {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)

  // With nothing in the queue the bar has no body to offer; the empty state belongs to the page and
  // to the desktop bar, not to a 64px strip that would only say "nothing".
  if (!current) return null

  const playing = status === 'playing'
  const total = durationMs || current.durationMs
  const position = total > 0 ? Math.min(total, Math.max(0, positionMs)) : 0

  return (
    <div role="region" aria-label={musicText('music.miniplayer.label')} className="music-miniplayer">
      <progress
        className="music-miniplayer__progress"
        max={total > 0 ? total : 1}
        value={position}
        aria-hidden="true"
      />
      <button
        type="button"
        className="music-miniplayer__body"
        aria-label={musicText('music.miniplayer.expand')}
        onClick={onExpand}
      >
        <Cover trackId={current.id} src={current.coverUrl || undefined} size="sm" radius="sm" />
        <span className="music-miniplayer__text">
          <span className="music-miniplayer__title">{current.title}</span>
          <span className="music-miniplayer__artist">
            {musicArtistNames(current)} · {formatDuration(current.durationMs)}
          </span>
        </span>
        <ChevronUp size={14} aria-hidden="true" className="music-miniplayer__chevron" />
      </button>
      <IconButton
        label={musicText(playing ? 'music.playbar.pause' : 'music.playbar.play')}
        size="lg"
        active={playing}
        onClick={() => {
          void toggle()
        }}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </IconButton>
      <IconButton
        label={musicText('music.playbar.next')}
        size="lg"
        onClick={() => {
          void next()
        }}
      >
        <SkipForward size={16} />
      </IconButton>
    </div>
  )
}
