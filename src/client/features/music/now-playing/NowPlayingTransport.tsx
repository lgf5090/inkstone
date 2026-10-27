/**
 * The Now Playing transport shared by the full sidebar and every slim bar.
 *
 * It reads the player store directly so a pane can mount one without threading a dozen callbacks
 * through the shell. The mode control opens a menu rather than cycling, because a cycle cannot name
 * the mode it is about to choose to a keyboard reader.
 */
import { useRef, useState, type ReactElement } from 'react'
import {
  FastForward,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  Rewind,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
} from 'lucide-react'
import { IconButton, Spinner } from '../../../components/primitives'
import { Menu } from '../../../components/overlay'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { musicText } from '../components/labels'

export function NowPlayingTransport({ compact = false }: { compact?: boolean }): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const mode = useMusicPlayer((state) => state.queue.mode)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)
  const setMode = useMusicPlayer((state) => state.setMode)
  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLButtonElement>(null)

  const playing = status === 'playing'
  const loading = status === 'loading'
  const failed = status === 'error' && current !== null
  const totalMs = durationMs || current?.durationMs || 0
  const seekBy = (deltaMs: number): void => {
    if (!current) return
    seek(Math.max(0, Math.min(totalMs, positionMs + deltaMs)))
  }
  const ModeIcon = mode === 'shuffle'
    ? Shuffle
    : mode === 'repeatOne'
      ? Repeat1
      : mode === 'repeat'
        ? Repeat
        : mode === 'intelligence'
          ? Sparkles
          : ListMusic
  const small = compact ? 'sm' : 'md'

  return (
    <div className="music-np__transport">
      <IconButton
        ref={modeRef}
        label={musicText(`music.mode.${mode}`)}
        size={small}
        aria-haspopup="menu"
        aria-expanded={modeOpen}
        onClick={() => setModeOpen(true)}
      >
        <ModeIcon size={compact ? 15 : 17} />
      </IconButton>
      <IconButton label={musicText('music.playbar.previous')} size="lg" onClick={() => { void prev() }}>
        <SkipBack size={compact ? 17 : 19} />
      </IconButton>
      <IconButton label={musicText('music.playbar.rewind')} size={small} onClick={() => seekBy(-10_000)}>
        <Rewind size={compact ? 15 : 17} />
      </IconButton>
      <IconButton
        className="music-np__play"
        label={musicText(failed ? 'music.playbar.retry' : playing ? 'music.playbar.pause' : 'music.playbar.play')}
        size="lg"
        aria-pressed={playing}
        aria-busy={loading || undefined}
        onClick={() => { void toggle() }}
      >
        {loading
          ? <Spinner size={compact ? 16 : 18} />
          : failed
            ? <RotateCcw size={compact ? 16 : 18} />
            : playing
              ? <Pause size={compact ? 17 : 19} />
              : <Play size={compact ? 17 : 19} />}
      </IconButton>
      <IconButton label={musicText('music.playbar.forward')} size={small} onClick={() => seekBy(10_000)}>
        <FastForward size={compact ? 15 : 17} />
      </IconButton>
      <IconButton label={musicText('music.playbar.next')} size="lg" onClick={() => { void next() }}>
        <SkipForward size={compact ? 17 : 19} />
      </IconButton>
      <Menu
        anchor={modeRef}
        open={modeOpen}
        onClose={() => setModeOpen(false)}
        items={(['order', 'repeat', 'repeatOne', 'shuffle', 'intelligence'] as const).map((value) => ({
          id: `np-mode-${value}`,
          label: musicText(`music.mode.${value}`),
          checked: mode === value,
          onSelect: () => {
            setMode(value)
            setModeOpen(false)
          },
        }))}
        align="start"
        width={200}
        label={musicText('music.playbar.mode')}
      />
    </div>
  )
}
