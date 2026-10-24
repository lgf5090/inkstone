/**
 * The persistent transport, in three zones: what is playing, the transport and progress, and the
 * switches that open the queue, the Now Playing lyrics tab and the overflow menu.
 *
 * The progress slider is `immediate`: a drag has to reach the audio element as it moves, and the
 * component's own coalescing would swallow the last value when the reader lets go. Times are printed
 * beside the slider instead of its numeric readout (hidden by the stylesheet), and the element keeps
 * the range semantics and the keyboard arrows for free.
 *
 * The favourite only returns on wide windows; the volume button opens the level popover and toggles
 * mute in the press itself. Below tablet width the mute switch moves into the overflow menu, and on a
 * phone the MiniPlayer and the full-screen layer are the surfaces instead of this bar.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import {
  Heart,
  ListMusic,
  Mic2,
  MoreHorizontal,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicPlayMode } from '@shared/music/model'
import { IconButton, Spinner } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { Drawer, Menu, Tooltip, useClickOutside, useEscape, type MenuItem } from '../../../components/overlay'
import { useMusicLibrary } from '../store/library'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { MUSIC_RATE_RANGE } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { Cover } from './Cover'
import { EqPanel } from './EqPanel'
import { SleepTimer } from './SleepTimer'
import { SourcePicker } from './SourcePicker'
import { musicText } from './labels'

const PLAY_MODES: readonly MusicPlayMode[] = ['order', 'repeat', 'repeatOne', 'shuffle']
const RATE_STEPS: readonly number[] = [1, 1.25, 1.5, 2].filter(
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

  const [moreOpen, setMoreOpen] = useState(false)
  const [panel, setPanel] = useState<'eq' | 'sleep' | 'source' | null>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
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

  const menuItems: MenuItem[] = [
    ...PLAY_MODES.map((value, index) => ({
      id: `mode-${value}`,
      label: musicText(`music.mode.${value}`),
      checked: mode === value,
      separatorBefore: index === 0,
      onSelect: () => setMode(value),
    })),
    ...RATE_STEPS.map((value) => ({
      id: `rate-${value}`,
      label: `${value}×`,
      checked: Math.abs(rate - value) < 0.001,
      separatorBefore: value === RATE_STEPS[0],
      onSelect: () => setRate(value),
    })),
    {
      id: 'mute',
      label: musicText(muted ? 'music.playbar.unmute' : 'music.playbar.mute'),
      checked: muted,
      separatorBefore: true,
      onSelect: () => toggleMute(),
    },
    {
      id: 'panel-eq',
      label: musicText('music.panel.eq'),
      separatorBefore: true,
      onSelect: () => setPanel('eq'),
    },
    {
      id: 'panel-sleep',
      label: musicText('music.panel.sleep'),
      onSelect: () => setPanel('sleep'),
    },
    {
      id: 'panel-source',
      label: musicText('music.panel.source'),
      onSelect: () => setPanel('source'),
    },
  ]

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
          <Tooltip label={musicText('music.mode.shuffle')}>
            <IconButton
              label={musicText('music.mode.shuffle')}
              size="sm"
              active={mode === 'shuffle'}
              aria-pressed={mode === 'shuffle'}
              onClick={() => setMode(mode === 'shuffle' ? 'order' : 'shuffle')}
            >
              <Shuffle size={15} />
            </IconButton>
          </Tooltip>
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
          {failed ? <Tooltip label={musicText(error ?? 'music.player.error.playback')}>{playButton}</Tooltip> : playButton}
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
          <Tooltip label={musicText(mode === 'repeatOne' ? 'music.mode.repeatOne' : 'music.mode.repeat')}>
            <IconButton
              label={musicText(mode === 'repeatOne' ? 'music.mode.repeatOne' : 'music.mode.repeat')}
              size="sm"
              active={mode === 'repeat' || mode === 'repeatOne'}
              aria-pressed={mode === 'repeat' || mode === 'repeatOne'}
              onClick={() => setMode(mode === 'repeat' ? 'repeatOne' : mode === 'repeatOne' ? 'order' : 'repeat')}
            >
              {mode === 'repeatOne' ? <Repeat1 size={15} /> : <Repeat size={15} />}
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
        <IconButton
          ref={moreRef}
          label={musicText('music.playbar.more')}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal size={16} />
        </IconButton>
        <Menu
          anchor={moreRef}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          items={menuItems}
          align="end"
          width={200}
          label={musicText('music.playbar.more')}
        />
        <Drawer
          open={panel !== null}
          onClose={() => setPanel(null)}
          side="right"
          width={340}
          title={panel ? musicText(`music.panel.${panel}`) : ''}
        >
          {panel === 'eq' && <EqPanel />}
          {panel === 'sleep' && <SleepTimer />}
          {panel === 'source' && <SourcePicker />}
        </Drawer>
      </div>
    </div>
  )
}
