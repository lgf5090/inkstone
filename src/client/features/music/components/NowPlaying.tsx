/**
 * The full-screen listening surface: what is playing on one side, lyrics or the queue on the other.
 *
 * The shared `Modal` owns the layer behaviour — focus moves in, Escape and the backdrop close it, and
 * focus returns to whatever opened it. The lyric pane is the existing embedded `LyricPanel`, so the
 * translation and offset controls are not duplicated here; the queue is a plain list of the player's
 * own tracks rather than a second copy of the queue drawer.
 *
 * A phone gets the same content stacked and full-height; the stylesheet switches the two columns at
 * the tablet breakpoint and keeps the home-indicator inset on the bottom edge.
 */
import { useRef, useState, type ReactElement } from 'react'
import {
  Heart,
  ListMusic,
  Music2,
  FastForward,
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
  X,
} from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import { Menu, Modal } from '../../../components/overlay'
import { useUi as useAppUi } from '../../../store/ui'
import { useMusicLibrary } from '../store/library'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicUi, type MusicNowPlayingTab } from '../store/ui'
import { Cover } from './Cover'
import { LyricPanel } from './LyricPanel'
import { MusicTabs, type MusicTabItem } from './Tabs'
import { musicText } from './labels'

export function NowPlaying(): ReactElement {
  const open = useMusicUi((state) => state.nowPlayingOpen)
  const tab = useMusicUi((state) => state.nowPlayingTab)
  const setNowPlayingOpen = useMusicUi((state) => state.setNowPlayingOpen)
  const setNowPlayingTab = useMusicUi((state) => state.setNowPlayingTab)
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const queue = useMusicPlayer((state) => state.queue)
  const toggle = useMusicPlayer((state) => state.toggle)
  const mode = useMusicPlayer((state) => state.queue.mode)
  const setMode = useMusicPlayer((state) => state.setMode)
  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLButtonElement>(null)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)
  const playTrack = useMusicPlayer((state) => state.playTrack)
  const favorites = useMusicLibrary((state) => state.favorites)
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)

  const close = (): void => setNowPlayingOpen(false)

  // The assistant is a separate surface owned by the app shell. Opening it closes this layer, so the
  // dock is not mounted behind a modal; its music context already names the track that is playing.
  const openAssistant = (): void => {
    const app = useAppUi.getState()
    if (!app.assistantDockOpen) app.toggleAssistantDock()
    close()
  }

  const favorite = current ? favorites.some((entry) => entry.id === current.id) : false
  const playing = status === 'playing'
  const loading = status === 'loading'
  const failed = status === 'error' && current !== null
  const totalMs = durationMs || current?.durationMs || 0
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000))
  const positionSeconds = Math.min(totalSeconds, Math.max(0, Math.round(positionMs / 1000)))
  const seekBy = (deltaMs: number): void => {
    if (!current) return
    seek(Math.max(0, Math.min(totalMs, positionMs + deltaMs)))
  }
  const ModeIcon = mode === 'shuffle' ? Shuffle : mode === 'repeatOne' ? Repeat1 : mode === 'repeat' ? Repeat : mode === 'intelligence' ? Sparkles : ListMusic
  const tabs: readonly MusicTabItem<MusicNowPlayingTab>[] = [
    { value: 'lyrics', label: musicText('music.lyrics.title') },
    { value: 'queue', label: musicText('music.queue.title'), count: queue.tracks.length },
  ]

  const closeButton = (
    <IconButton size="sm" label={musicText('common.close')} onClick={close}>
      <X size={17} />
    </IconButton>
  )

  return (
    <Modal
      open={open}
      onClose={close}
      width={1120}
      ariaLabel={musicText('music.nowplaying.title')}
      className="music-nowplaying"
      bodyClassName="music-nowplaying__body"
    >
      {!current ? (
        <div className="music-nowplaying__layout music-nowplaying__layout--empty">
          <header className="music-nowplaying__topbar">
            <h2 className="music-nowplaying__eyebrow">{musicText('music.nowplaying.title')}</h2>
            {closeButton}
          </header>
          <div className="music-nowplaying__empty">
            <Music2 size={26} aria-hidden="true" />
            <p>{musicText('music.nowplaying.empty')}</p>
          </div>
        </div>
      ) : (
        <div className="music-nowplaying__layout">
          <section aria-label={musicText('music.nowplaying.title')} className="music-nowplaying__stage">
            <header className="music-nowplaying__topbar">
              <h2 className="music-nowplaying__eyebrow">{musicText('music.nowplaying.title')}</h2>
              {closeButton}
            </header>

            <Cover
              trackId={current.id}
              src={current.coverUrl || undefined}
              version={current.updatedAt}
              size="hero"
              radius="lg"
              className="music-nowplaying__cover"
            />

            <div className="music-nowplaying__heading">
              <h3 className="music-nowplaying__title" title={current.title}>
                {current.title}
              </h3>
              <p className="music-nowplaying__artist">{musicArtistNames(current)}</p>
            </div>

            <div className="music-nowplaying__progress">
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

            <div className="music-nowplaying__transport">
              <IconButton ref={modeRef} label={musicText(`music.mode.${mode}`)} size="sm" aria-haspopup="menu" aria-expanded={modeOpen} onClick={() => setModeOpen(true)}>
                <ModeIcon size={17} />
              </IconButton>
              <IconButton label={musicText('music.playbar.previous')} size="lg" onClick={() => { void prev() }}>
                <SkipBack size={19} />
              </IconButton>
              <IconButton label={musicText('music.playbar.rewind')} size="sm" onClick={() => seekBy(-10_000)}>
                <Rewind size={17} />
              </IconButton>
              <IconButton
                className="music-playbar__play music-nowplaying__play"
                label={musicText(failed ? 'music.playbar.retry' : playing ? 'music.playbar.pause' : 'music.playbar.play')}
                size="lg"
                active={playing}
                aria-busy={loading || undefined}
                onClick={() => { void toggle() }}
              >
                {loading ? <Spinner size={18} /> : failed ? <RotateCcw size={18} /> : playing ? <Pause size={19} /> : <Play size={19} />}
              </IconButton>
              <IconButton label={musicText('music.playbar.forward')} size="sm" onClick={() => seekBy(10_000)}>
                <FastForward size={17} />
              </IconButton>
              <IconButton label={musicText('music.playbar.next')} size="lg" onClick={() => { void next() }}>
                <SkipForward size={19} />
              </IconButton>
            </div>

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
            <div className="music-nowplaying__actions">
              <IconButton
                label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
                active={favorite}
                onClick={() => { void toggleFavorite(current) }}
              >
                <Heart size={17} className={favorite ? 'fill-current' : undefined} />
              </IconButton>
              <Button size="sm" variant="secondary" icon={<Sparkles size={14} />} onClick={openAssistant}>
                {musicText('music.nav.assistant')}
              </Button>
            </div>
          </section>

          <div className="music-nowplaying__panel">
            <MusicTabs
              value={tab}
              items={tabs}
              onChange={setNowPlayingTab}
              label={musicText('music.nowplaying.title')}
              className="music-nowplaying__tabs"
            />
            <div
              role="tabpanel"
              aria-label={musicText(tab === 'lyrics' ? 'music.lyrics.title' : 'music.queue.title')}
              className="music-nowplaying__tabpanel"
            >
              {tab === 'lyrics' ? (
                <LyricPanel variant="embedded" className="music-nowplaying__lyrics" />
              ) : queue.tracks.length === 0 ? (
                <div className="music-nowplaying__empty">
                  <ListMusic size={24} aria-hidden="true" />
                  <p>{musicText('music.queue.empty')}</p>
                </div>
              ) : (
                <ol className="music-queue music-nowplaying__queue" aria-label={musicText('music.queue.title')}>
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
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
