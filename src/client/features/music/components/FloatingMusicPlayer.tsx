/**
 * The player that follows the reader out of the music app.
 *
 * It is mounted above every authed app, hides itself on the music address (that frame already has a
 * transport), and draws through a portal so no app's overflow can clip it. The panel remembers its
 * corner and whether it was folded; the folded form is a cover with a progress ring so the player is
 * still readable in a 64px corner.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ExternalLink,
  FastForward,
  GripHorizontal,
  Heart,
  ListMusic,
  ListOrdered,
  Mic2,
  Minimize2,
  Moon,
  Pause,
  Pin,
  PinOff,
  Play,
  Repeat,
  Repeat1,
  Rewind,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { findActiveLineIndex } from '@shared/music/lyrics'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { MUSIC_PLAY_MODES } from '@shared/music/model'
import { navigateToPath, usePathname } from '../../../lib/app-history'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Slider } from '../../../components/form'
import { Cover } from './Cover'
import { EqPanel } from './EqPanel'
import { SleepTimer } from './SleepTimer'
import { useTrackLyrics } from './LyricPanel'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicLibrary } from '../store/library'
import { useMusicSettings } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { musicText } from './labels'

const STORAGE_KEY = 'inkstone.music.floating'
const PANEL_WIDTH = 340
const PANEL_HEIGHT = 372
const RATE_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2]
const RING_RADIUS = 30
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

interface FloatingPrefs {
  x?: number
  y?: number
  collapsed?: boolean
}

interface Point {
  x: number
  y: number
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  origin: Point
  moved: boolean
  captured: boolean
}

function readPrefs(): FloatingPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    return {
      x: typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : undefined,
      y: typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : undefined,
      collapsed: record.collapsed === true,
    }
  } catch {
    // A corrupt or unavailable preference falls back to the default corner.
    return {}
  }
}

function writePrefs(value: FloatingPrefs & { x: number; y: number; collapsed: boolean }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Position is a convenience, not state the player needs; denied storage keeps the memory copy.
  }
}

function defaultPosition(): Point {
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
  return {
    x: Math.max(8, window.innerWidth - width - 16),
    y: Math.max(8, window.innerHeight - PANEL_HEIGHT - 16),
  }
}

function clampPosition(point: Point, width: number, height: number): Point {
  const maxX = Math.max(8, window.innerWidth - width - 8)
  const maxY = Math.max(8, window.innerHeight - height - 8)
  return {
    x: Math.min(maxX, Math.max(8, point.x)),
    y: Math.min(maxY, Math.max(8, point.y)),
  }
}

export function FloatingMusicPlayer(): ReactElement | null {
  const pathname = usePathname()
  const hidden = pathname.startsWith('/music') || pathname.startsWith('/m/')
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const volume = useMusicPlayer((state) => state.volume)
  const muted = useMusicPlayer((state) => state.muted)
  const rate = useMusicPlayer((state) => state.rate)
  const mode = useMusicPlayer((state) => state.queue.mode)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)
  const setVolume = useMusicPlayer((state) => state.setVolume)
  const setMuted = useMusicPlayer((state) => state.setMuted)
  const setRate = useMusicPlayer((state) => state.setRate)
  const setMode = useMusicPlayer((state) => state.setMode)
  const queueTracks = useMusicPlayer((state) => state.queue.tracks)
  const playTrack = useMusicPlayer((state) => state.playTrack)
  const favoriteEntry = useMusicLibrary((state) =>
    current ? state.favorites.find((entry) => entry.id === current.id) : undefined)
  const toggleFavorite = useMusicLibrary((state) => state.toggleFavorite)
  const setFavoritePinned = useMusicLibrary((state) => state.setFavoritePinned)
  const lyric = useTrackLyrics(hidden ? null : current)
  const [initial] = useState(readPrefs)
  const [collapsed, setCollapsed] = useState(() => initial.collapsed ?? false)
  const [panelTab, setPanelTab] = useState<'queue' | 'eq' | 'sleep' | null>(null)
  const [queueFilter, setQueueFilter] = useState('')
  const [pos, setPos] = useState<Point>(() => (
    initial.x !== undefined && initial.y !== undefined
      ? { x: initial.x, y: initial.y }
      : defaultPosition()
  ))
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    useMusicPlayer.getState().restore()
    if (useMusicSettings.getState().serverStatus === 'idle') {
      void useMusicSettings.getState().loadServer()
    }
  }, [])

  useEffect(() => {
    if (!current) return
    const library = useMusicLibrary.getState()
    if (library.status === 'idle') {
      void library.load().then(() => useMusicLibrary.getState().loadAllFavorites())
    }
  }, [current?.id])

  useEffect(() => {
    const element = panelRef.current
    if (!element) return
    const clampNow = (): void => {
      const rect = element.getBoundingClientRect()
      setPos((point) => clampPosition(point, rect.width, rect.height))
    }
    clampNow()
    window.addEventListener('resize', clampNow)
    return () => window.removeEventListener('resize', clampNow)
  }, [collapsed, panelTab])

  useEffect(() => {
    writePrefs({ ...pos, collapsed })
  }, [collapsed, pos])

  if (!current || hidden) return null

  const playing = status === 'playing'
  const loading = status === 'loading'
  const favorite = Boolean(favoriteEntry)
  const total = durationMs > 0 ? durationMs : current.durationMs
  const activeIndex = findActiveLineIndex(lyric.lines, positionMs)
  const lyricLines = lyric.lines.slice(Math.max(0, activeIndex), Math.max(0, activeIndex) + 2)
  const progress = total > 0 ? Math.min(1, Math.max(0, positionMs / total)) : 0
  const normalizedQueueFilter = queueFilter.trim().toLowerCase()
  const filteredQueue = normalizedQueueFilter
    ? queueTracks.filter((track) => `${track.title} ${musicArtistNames(track)}`.toLowerCase().includes(normalizedQueueFilter))
    : queueTracks
  const ModeIcon = mode === 'shuffle'
    ? Shuffle
    : mode === 'repeatOne'
      ? Repeat1
      : mode === 'repeat'
        ? Repeat
        : mode === 'intelligence'
          ? Sparkles
          : ListOrdered

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, allowButton: boolean): void => {
    if (event.button !== 0) return
    if (!allowButton && (event.target as HTMLElement).closest('button')) return
    const element = panelRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: rect.left, y: rect.top },
      moved: false,
      captured: false,
    }
    suppressClickRef.current = false
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    if (!drag.moved) return
    event.preventDefault()
    if (!drag.captured) {
      // Capture only after a real drag. Capturing on pointerdown retargets the click to this wrapper
      // and a plain tap never reaches the folded cover button that opens the panel.
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.captured = true
    }
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos(clampPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, rect.width, rect.height))
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.moved) suppressClickRef.current = true
    dragRef.current = null
    if (drag.captured) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const expand = (): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setCollapsed(false)
  }

  const seekBy = (deltaMs: number): void => {
    seek(Math.max(0, Math.min(total, positionMs + deltaMs)))
  }

  const cycleMode = (): void => {
    const index = MUSIC_PLAY_MODES.indexOf(mode)
    setMode(MUSIC_PLAY_MODES[(index + 1) % MUSIC_PLAY_MODES.length] ?? 'order')
  }

  const cycleRate = (): void => {
    const index = RATE_STEPS.findIndex((step) => step >= rate - 0.001)
    const nextRate = RATE_STEPS[(index + 1) % RATE_STEPS.length] ?? 1
    setRate(nextRate)
  }

  const openMusic = (): void => navigateToPath('/music')
  const togglePanel = (tab: 'queue' | 'eq' | 'sleep'): void => {
    setPanelTab((currentTab) => currentTab === tab ? null : tab)
  }
  const openLyrics = (): void => {
    useMusicUi.getState().setNowPlayingOpen(true, 'lyrics')
    navigateToPath('/music')
  }

  const dragHandlers = {
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }

  const panel = collapsed
    ? (
        <div
          ref={panelRef}
          className="music-floating music-floating--collapsed"
          style={{ left: pos.x, top: pos.y }}
          role="region"
          aria-label={musicText('music.floating.title')}
        >
          <button
            type="button"
            className="music-floating__orb"
            aria-label={musicText('music.floating.expand_track', { title: current.title })}
            onClick={expand}
            onPointerDown={(event) => beginDrag(event, true)}
            {...dragHandlers}
          >
            <svg className="music-floating__ring" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="var(--border-default)" strokeWidth="2.5" />
              <circle
                cx="32"
                cy="32"
                r={RING_RADIUS}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - progress)}
                transform="rotate(-90 32 32)"
              />
            </svg>
            <Cover
              trackId={current.id}
              src={current.coverUrl || undefined}
              version={current.updatedAt}
              size="md"
              radius="full"
            />
          </button>
          <button
            type="button"
            className="music-floating__orb-toggle"
            aria-label={musicText(playing ? 'music.playbar.pause' : 'music.playbar.play')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => { void toggle() }}
          >
            {playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
          </button>
        </div>
      )
    : (
        <div
          ref={panelRef}
          className="music-floating music-floating--expanded"
          style={{ left: pos.x, top: pos.y }}
          role="region"
          aria-label={musicText('music.floating.title')}
        >
          <div
            className="music-floating__header"
            onPointerDown={(event) => beginDrag(event, false)}
            {...dragHandlers}
          >
            <span className="music-floating__grip" aria-hidden="true">
              <GripHorizontal size={15} />
            </span>
            <span className="music-floating__heading">{musicText('music.floating.title')}</span>
            <span
              className={playing ? 'music-floating__equalizer music-floating__equalizer--playing' : 'music-floating__equalizer'}
              aria-hidden="true"
            >
              {[0, 1, 2, 3, 4].map((bar) => <span key={bar} />)}
            </span>
            <div className="music-floating__header-actions">
              <IconButton label={musicText('music.playbar.lyrics')} size="xs" onClick={openLyrics}>
                <Mic2 size={14} />
              </IconButton>
              <IconButton label={musicText('music.floating.open')} size="xs" onClick={openMusic}>
                <ExternalLink size={14} />
              </IconButton>
              <IconButton
                label={musicText('music.floating.collapse')}
                size="xs"
                onClick={() => {
                  setPanelTab(null)
                  setCollapsed(true)
                }}
              >
                <Minimize2 size={15} />
              </IconButton>
            </div>
          </div>

          <div className="music-floating__identity">
            <Cover
              trackId={current.id}
              src={current.coverUrl || undefined}
              version={current.updatedAt}
              size="md"
              radius="full"
            />
            <span className="music-floating__text">
              <span className="music-floating__title" title={current.title}>{current.title}</span>
              <span className="music-floating__artist">{musicArtistNames(current)}</span>
            </span>
            <IconButton
              label={musicText(favorite ? 'music.song.unfavorite' : 'music.song.favorite')}
              size="xs"
              active={favorite}
              onClick={() => { void toggleFavorite(current) }}
            >
              <Heart size={14} className={favorite ? 'fill-current' : undefined} />
            </IconButton>
            {favoriteEntry && (
              <IconButton
                label={musicText(favoriteEntry.pinnedAt ? 'music.song.unpin' : 'music.song.pin')}
                size="xs"
                active={Boolean(favoriteEntry.pinnedAt)}
                onClick={() => { void setFavoritePinned(current.id, !favoriteEntry.pinnedAt) }}
              >
                {favoriteEntry.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
              </IconButton>
            )}
          </div>

          <div className="music-floating__lyrics" aria-live="off">
            {lyricLines.length > 0
              ? lyricLines.map((line, index) => (
                  <p key={`${line.startTime}-${index}`} className={index === 0 ? 'music-floating__lyric music-floating__lyric--active' : 'music-floating__lyric'}>
                    {line.fullText}
                    {line.translation && <span className="music-floating__translation">{line.translation}</span>}
                  </p>
                ))
              : (
                  <p className="music-floating__lyric music-floating__lyric--muted">
                    {musicText('music.lyrics.empty')}
                  </p>
                )}
          </div>

          <div className="music-floating__progress">
            <Slider
              label={musicText('music.playbar.progress')}
              value={Math.min(positionMs, Math.max(1, total))}
              min={0}
              max={Math.max(1, total)}
              step={1000}
              immediate
              className="music-floating__slider"
              onChange={(value) => seek(value)}
            />
            <div className="music-floating__times">
              <span>{formatDuration(positionMs)}</span>
              <span>{formatDuration(total)}</span>
            </div>
          </div>

          <div className="music-floating__transport">
            <IconButton
              label={musicText('music.playbar.mode_cycle', { mode: musicText(`music.mode.${mode}`) })}
              size="xs"
              onClick={cycleMode}
            >
              <ModeIcon size={14} />
            </IconButton>
            <IconButton label={musicText('music.playbar.previous')} size="sm" onClick={() => { void prev() }}>
              <SkipBack size={15} />
            </IconButton>
            <IconButton label={musicText('music.playbar.rewind')} size="xs" onClick={() => seekBy(-10_000)}>
              <Rewind size={14} />
            </IconButton>
            <IconButton
              className="music-floating__play"
              label={musicText(playing ? 'music.playbar.pause' : 'music.playbar.play')}
              size="lg"
              active={playing}
              aria-busy={loading || undefined}
              onClick={() => { void toggle() }}
            >
              {playing ? <Pause size={20} /> : <Play size={20} />}
            </IconButton>
            <IconButton label={musicText('music.playbar.forward')} size="xs" onClick={() => seekBy(10_000)}>
              <FastForward size={14} />
            </IconButton>
            <IconButton label={musicText('music.playbar.next')} size="sm" onClick={() => { void next() }}>
              <SkipForward size={15} />
            </IconButton>
            <IconButton
              label={musicText('music.playbar.queue')}
              size="xs"
              active={panelTab === 'queue'}
              onClick={() => togglePanel('queue')}
            >
              <ListMusic size={14} />
              <span className="music-floating__badge" aria-hidden="true">{queueTracks.length}</span>
            </IconButton>
          </div>

          <div className="music-floating__footer">
            <IconButton
              label={musicText(muted ? 'music.playbar.unmute' : 'music.playbar.mute')}
              size="xs"
              onClick={() => setMuted(!muted)}
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              onClick={cycleRate}
              aria-label={musicText('music.playbar.rate', { rate })}
            >
              {rate}×
            </Button>
            <Slider
              label={musicText('music.playbar.volume')}
              value={muted ? 0 : volume}
              min={0}
              max={1}
              step={0.01}
              className="music-floating__volume"
              onChange={(value) => setVolume(value)}
            />
            <IconButton
              label={musicText('music.panel.eq')}
              size="xs"
              active={panelTab === 'eq'}
              onClick={() => togglePanel('eq')}
            >
              <SlidersHorizontal size={14} />
            </IconButton>
            <IconButton
              label={musicText('music.panel.sleep')}
              size="xs"
              active={panelTab === 'sleep'}
              onClick={() => togglePanel('sleep')}
            >
              <Moon size={14} />
            </IconButton>
          </div>

          {panelTab && (
            <div className="music-floating__sheet">
              <div className="music-floating__sheet-head">
                <span>{musicText(panelTab === 'queue' ? 'music.queue.title' : panelTab === 'eq' ? 'music.panel.eq' : 'music.panel.sleep')}</span>
                <IconButton label={musicText('music.floating.close_panel')} size="xs" onClick={() => setPanelTab(null)}>
                  <X size={13} />
                </IconButton>
              </div>
              {panelTab === 'queue'
                ? (
                    <div className="music-floating__queue">
                      <Input
                        value={queueFilter}
                        leading={<Search size={13} aria-hidden="true" />}
                        trailing={queueFilter ? (
                          <button
                            type="button"
                            aria-label={musicText('music.local.clear_filter')}
                            className="grid h-5 w-5 place-items-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                            onClick={() => setQueueFilter('')}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        ) : undefined}
                        placeholder={musicText('music.queue.search')}
                        aria-label={musicText('music.queue.search')}
                        onChange={(event) => setQueueFilter(event.target.value)}
                      />
                      {filteredQueue.length === 0
                        ? <p className="music-floating__queue-empty">{musicText('music.queue.no_match')}</p>
                        : (
                            <ul className="music-floating__queue-list">
                              {filteredQueue.map((track, index) => (
                                <li key={track.id}>
                                  <button
                                    type="button"
                                    className={track.id === current.id
                                      ? 'music-floating__queue-row music-floating__queue-row--active'
                                      : 'music-floating__queue-row'}
                                    aria-current={track.id === current.id ? 'true' : undefined}
                                    onClick={() => { void playTrack(track, { queue: queueTracks }) }}
                                  >
                                    <span className="music-floating__queue-index" aria-hidden="true">{index + 1}</span>
                                    <Cover
                                      trackId={track.id}
                                      src={track.coverUrl || undefined}
                                      version={track.updatedAt}
                                      size="xs"
                                      radius="sm"
                                    />
                                    <span className="music-floating__queue-text">
                                      <span className="music-floating__queue-title" title={track.title}>{track.title}</span>
                                      <span className="music-floating__queue-artist">{musicArtistNames(track)}</span>
                                    </span>
                                    <span className="music-floating__queue-time">{formatDuration(track.durationMs)}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                    </div>
                  )
                : panelTab === 'eq'
                  ? <EqPanel />
                  : <SleepTimer />}
            </div>
          )}
        </div>
      )

  return createPortal(panel, document.body)
}
