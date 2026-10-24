/**
 * The persistent transport, in three zones: what is playing, the transport and progress, and the
 * toolbar that cycles the play mode and opens the rate menu, volume, lyrics, queue, equalizer, sleep
 * timer and source picker.
 *
 * The progress slider is `immediate`: a drag has to reach the audio element as it moves, and the
 * component's own coalescing would swallow the last value when the reader lets go. Times are printed
 * beside the slider instead of its numeric readout (hidden by the stylesheet), and the element keeps
 * the range semantics and the keyboard arrows for free.
 *
 * The favourite only returns on wide windows; the volume button opens the level popover and toggles
 * mute in the press itself. The mode control is a cycle rather than a menu, so one press always
 * changes the mode and the icon follows the store. On a phone the MiniPlayer and the full-screen
 * layer are the surfaces instead of this bar.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import {
  Heart,
  ListMusic,
  Mic2,
  Moon,
  Music,
  Radio,
  SlidersHorizontal,
  Pause,
  Play,
  FastForward,
  Repeat,
  Repeat1,
  Rewind,
  RotateCcw,
  Shuffle,
  Sparkles,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { MUSIC_PLAY_MODES } from '@shared/music/model'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { Drawer, Menu, Tooltip, useClickOutside, useEscape } from '../../../components/overlay'
import { Z_INDEX } from '../../../lib/z-index'
import { useMusicLibrary } from '../store/library'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { MUSIC_RATE_RANGE } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { Cover } from './Cover'
import { EqPanel } from './EqPanel'
import { SleepTimer } from './SleepTimer'
import { SourcePicker } from './SourcePicker'
import { musicText } from './labels'

const RATE_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2].filter(
  (rate) => rate >= MUSIC_RATE_RANGE.min && rate <= MUSIC_RATE_RANGE.max,
)

export function PlayBar(): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const volume = useMusicPlayer((state) => state.volume)
  const muted = useMusicPlayer((state) => state.muted)
  const rate = useMusicPlayer((state) => state.rate)
  const mode = useMusicPlayer((state) => state.queue.mode)
  const awaitingGesture = useMusicPlayer((state) => state.awaitingGesture)
  const error = useMusicPlayer((state) => state.error)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)
  const setVolume = useMusicPlayer((state) => state.setVolume)
  const toggleMute = useMusicPlayer((state) => state.toggleMute)
  const setRate = useMusicPlayer((state) => state.setRate)
  const setMode = useMusicPlayer((state) => state.setMode)
  const favorites = useMusicLibrary((state) => state.favorites)
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)
  const queueOpen = useMusicUi((state) => state.queueOpen)
  const nowPlayingOpen = useMusicUi((state) => state.nowPlayingOpen)
  const nowPlayingTab = useMusicUi((state) => state.nowPlayingTab)
  const toggleQueue = useMusicUi((state) => state.toggleQueue)
  const setNowPlayingOpen = useMusicUi((state) => state.setNowPlayingOpen)

  const [rateOpen, setRateOpen] = useState(false)
  const [panel, setPanel] = useState<'eq' | 'sleep' | 'source' | null>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const rateRef = useRef<HTMLButtonElement>(null)
  const volumeRef = useRef<HTMLButtonElement>(null)
  const volumePanelRef = useRef<HTMLDivElement>(null)
  const volumePanelId = useId()

  useClickOutside([volumeRef, volumePanelRef], volumeOpen, () => setVolumeOpen(false))
  useEscape(volumeOpen, () => {
    setVolumeOpen(false)
    volumeRef.current?.focus({ preventScroll: true })
  })
  useEffect(() => {
    if (!volumeOpen) return
    volumePanelRef.current
      ?.querySelector<HTMLInputElement>('input[type="range"]')
      ?.focus({ preventScroll: true })
  }, [volumeOpen])

  const favorite = current ? favorites.some((entry) => entry.id === current.id) : false
  const playing = status === 'playing'
  const failed = status === 'error' && current !== null
  const loading = status === 'loading'
  const totalMs = durationMs || current?.durationMs || 0
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000))
  const positionSeconds = Math.min(totalSeconds, Math.max(0, Math.round(positionMs / 1000)))
  // The popover shows the level a drag would restore, not 0: the press that opens it also mutes.
  const volumePercent = Math.round(volume * 100)

  const playLabel = failed
    ? 'music.playbar.retry'
    : playing
      ? 'music.playbar.pause'
      : 'music.playbar.play'
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

  const playButton = (
    <IconButton
      className="music-playbar__play"
      size="lg"
      label={musicText(playLabel)}
      active={playing}
      aria-busy={loading || undefined}
      onClick={() => {
        void toggle()
      }}
    >
      {loading ? (
        <Spinner size={15} />
      ) : failed ? (
        <RotateCcw size={16} />
      ) : playing ? (
        <Pause size={16} />
      ) : (
        <Play size={16} />
      )}
    </IconButton>
  )

  if (!current) {
    return (
      <div
        role="region"
        aria-label={musicText('music.playbar.label')}
        className="music-playbar music-playbar--empty"
      >
        <div className="music-playbar__empty">
          <Music size={18} aria-hidden="true" />
          <span className="music-playbar__empty-text">
            <span className="music-playbar__empty-title">{musicText('music.playbar.empty')}</span>
            <span className="music-playbar__empty-hint">{musicText('music.playbar.hint')}</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-label={musicText('music.playbar.label')}
      className="music-playbar"
    >
      <div className="music-playbar__left">
        <Cover trackId={current.id} src={current.coverUrl || undefined} size="sm" radius="sm" className="music-playbar__cover" />
        <span className="music-playbar__meta">
          <span className="music-playbar__title">{current.title}</span>
          <span className="music-playbar__artist">
            {awaitingGesture ? musicText('music.playbar.resume') : musicArtistNames(current)}
          </span>
        </span>
        <IconButton
          className="music-playbar__favorite"
          label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
          size="sm"
          active={favorite}
          onClick={() => {
            void toggleFavorite(current)
          }}
        >
          <Heart size={15} className={favorite ? 'fill-current' : undefined} />
        </IconButton>
      </div>

      <div className="music-playbar__center">
        <div className="music-playbar__transport">
          <Tooltip label={musicText('music.playbar.mode_cycle', { mode: musicText(`music.mode.${mode}`) })}>
            <IconButton
              label={musicText('music.playbar.mode_cycle', { mode: musicText(`music.mode.${mode}`) })}
              size="sm"
              onClick={() => {
                const index = MUSIC_PLAY_MODES.indexOf(mode)
                setMode(MUSIC_PLAY_MODES[(index + 1) % MUSIC_PLAY_MODES.length] ?? 'order')
              }}
            >
              <ModeIcon size={15} />
            </IconButton>
          </Tooltip>
          <span className="sr-only" role="status" aria-live="polite">{musicText(`music.mode.${mode}`)}</span>
          <Tooltip label={musicText('music.playbar.previous')}>
            <IconButton
              label={musicText('music.playbar.previous')}
              onClick={() => {
                void prev()
              }}
            >
              <SkipBack size={16} />
            </IconButton>
          </Tooltip>
          <IconButton label={musicText('music.playbar.rewind')} size="sm" onClick={() => seekBy(-10_000)}>
            <Rewind size={15} />
          </IconButton>
          {failed ? <Tooltip label={musicText(error ?? 'music.player.error.playback')}>{playButton}</Tooltip> : playButton}
          <IconButton label={musicText('music.playbar.forward')} size="sm" onClick={() => seekBy(10_000)}>
            <FastForward size={15} />
          </IconButton>
          <Tooltip label={musicText('music.playbar.next')}>
            <IconButton
              label={musicText('music.playbar.next')}
              onClick={() => {
                void next()
              }}
            >
              <SkipForward size={16} />
            </IconButton>
          </Tooltip>
        </div>
        <div className="music-playbar__progress">
          <span className="music-playbar__time">{formatDuration(positionMs)}</span>
          <Slider
            className="music-playbar__slider"
            label={musicText('music.playbar.progress')}
            value={positionSeconds}
            min={0}
            max={totalSeconds}
            step={1}
            suffix="s"
            immediate
            onChange={(value) => seek(value * 1000)}
          />
          <span className="music-playbar__time music-playbar__time--end">{formatDuration(totalMs)}</span>
        </div>
      </div>

      <div className="music-playbar__right">
        <div className="music-playbar__volume-wrap">
          <IconButton
            ref={volumeRef}
            label={musicText(muted ? 'music.playbar.unmute' : 'music.playbar.mute')}
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={volumeOpen}
            aria-controls={volumeOpen ? volumePanelId : undefined}
            onClick={() => {
              toggleMute()
              setVolumeOpen(true)
            }}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </IconButton>
          {volumeOpen && (
            <div
              ref={volumePanelRef}
              id={volumePanelId}
              role="dialog"
              aria-label={musicText('music.playbar.volume')}
              className="music-playbar__volume-panel"
            >
              <Slider
                className="music-playbar__volume"
                label={musicText('music.playbar.volume')}
                value={volumePercent}
                min={0}
                max={100}
                step={1}
                onChange={(value) => setVolume(value / 100)}
              />
            </div>
          )}
        </div>
        <Tooltip label={musicText('music.playbar.lyrics')}>
          <IconButton
            label={musicText('music.playbar.lyrics')}
            size="sm"
            active={nowPlayingOpen && nowPlayingTab === 'lyrics'}
            onClick={() => setNowPlayingOpen(true, 'lyrics')}
          >
            <Mic2 size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={musicText('music.playbar.queue')}>
          <IconButton
            label={musicText('music.playbar.queue')}
            size="sm"
            active={queueOpen}
            onClick={() => toggleQueue()}
          >
            <ListMusic size={15} />
          </IconButton>
        </Tooltip>
        <Button
          ref={rateRef}
          variant="ghost"
          size="sm"
          aria-label={musicText('music.playbar.rate', { rate })}
          aria-haspopup="menu"
          aria-expanded={rateOpen}
          onClick={() => setRateOpen(true)}
          className="tabular"
        >
          {rate}×
        </Button>
        <Menu
          anchor={rateRef}
          open={rateOpen}
          onClose={() => setRateOpen(false)}
          items={RATE_STEPS.map((value) => ({
            id: `rate-${value}`,
            label: `${value}×`,
            checked: Math.abs(rate - value) < 0.001,
            onSelect: () => {
              setRate(value)
              setRateOpen(false)
            },
          }))}
          align="end"
          width={160}
          label={musicText('music.playbar.rate', { rate })}
        />
        <Tooltip label={musicText('music.panel.eq')}>
          <IconButton
            label={musicText('music.panel.eq')}
            size="sm"
            active={panel === 'eq'}
            onClick={() => setPanel('eq')}
          >
            <SlidersHorizontal size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={musicText('music.panel.sleep')}>
          <IconButton
            label={musicText('music.panel.sleep')}
            size="sm"
            active={panel === 'sleep'}
            onClick={() => setPanel('sleep')}
          >
            <Moon size={15} />
          </IconButton>
        </Tooltip>
        <Tooltip label={musicText('music.panel.source')}>
          <IconButton
            label={musicText('music.panel.source')}
            size="sm"
            active={panel === 'source'}
            onClick={() => setPanel('source')}
          >
            <Radio size={15} />
          </IconButton>
        </Tooltip>
        <Drawer
          open={panel !== null}
          onClose={() => setPanel(null)}
          side="right"
          width={340}
          title={panel ? musicText(`music.panel.${panel}`) : ''}
          bodyClassName="p-4"
          // The assistant dock lives at `--z-panel`; a panel the reader opened from the bar must sit
          // above it rather than under the column it may be covering.
          zIndex={Z_INDEX.workspace}
        >
          {panel === 'eq' && <EqPanel />}
          {panel === 'sleep' && <SleepTimer />}
          {panel === 'source' && <SourcePicker />}
        </Drawer>
      </div>
    </div>
  )
}
