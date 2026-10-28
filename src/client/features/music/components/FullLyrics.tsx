/**
 * The listening layer: artwork colour, timed lyric and the transport, over a blurred cover.
 *
 * The surface is the shared full-screen `Modal`, so focus moves in, Escape closes it and the backdrop
 * is a second way out. The active line keeps the reader's place, and a press on any timed line seeks
 * to it. Motion is the one enhancement: scrolling jumps and words do not fade when the reader asked
 * for reduced motion.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import {
  Languages,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import { isInstrumentalLyrics } from '@shared/music/lyrics'
import { musicTrackKey } from '@shared/music/model'
import { IconButton, Spinner } from '../../../components/primitives'
import { Slider, Switch } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { musicApi } from '../api'
import { applyMusicThemeColors, loadCoverThemeColors } from '../player/theme-color'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { useMusicSettings } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { LyricSettings } from './LyricSettings'
import { QuietCommentLayer } from '../comments/QuietCommentLayer'
import {
  LyricLineContent,
  useActiveLyricLine,
  LyricOffsetControls,
  useActiveLineScroll,
  useLyricOffset,
  useTrackLyrics,
} from './LyricPanel'
import { musicText } from './labels'

const MAX_ACTIVE_FONT_SIZE = 56
const ACTIVE_LINE_SCALE = 1.35

export function FullLyrics(): ReactElement | null {
  const open = useMusicUi((state) => state.lyricsOpen)
  return open ? <FullLyricsLayer /> : null
}

function FullLyricsLayer(): ReactElement {
  const open = useMusicUi((state) => state.lyricsOpen)
  const setLyricsOpen = useMusicUi((state) => state.setLyricsOpen)
  const current = useMusicPlayer(selectCurrentTrack)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const toggle = useMusicPlayer((state) => state.toggle)
  const next = useMusicPlayer((state) => state.next)
  const prev = useMusicPlayer((state) => state.prev)
  const seek = useMusicPlayer((state) => state.seek)
  const preferences = useMusicSettings((state) => state.local.lyrics)
  const setLyrics = useMusicSettings((state) => state.setLyrics)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [offset, setOffset] = useLyricOffset(current)
  const lyric = useTrackLyrics(current)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const playing = status === 'playing'
  const activeIndex = useActiveLyricLine(lyric.lines, positionMs, offset, playing)
  useActiveLineScroll(scrollRef, activeIndex, current ? musicTrackKey(current.provider, current.providerId) : '')
  const instrumental = isInstrumentalLyrics(lyric.lines)

  // The cover tint belongs to the open layer. Closing it restores the design tokens for whatever
  // surface is mounted next.
  const coverUrl = current ? musicApi.coverUrl(current.id) : ''
  useEffect(() => {
    const element = rootRef.current
    if (!open || !element || !coverUrl) return
    let active = true
    void loadCoverThemeColors(coverUrl).then((colors) => {
      if (active) applyMusicThemeColors(element, colors)
    })
    return () => {
      active = false
      applyMusicThemeColors(element, null)
    }
  }, [coverUrl, open])

  const totalMs = durationMs || current?.durationMs || 0
  const totalSeconds = Math.max(1, Math.round(totalMs / 1000))
  const positionSeconds = Math.min(totalSeconds, Math.max(0, Math.round(positionMs / 1000)))
  const close = (): void => setLyricsOpen(false)

  const seekToLine = (startTime: number): void => {
    // Undo the offset so the pressed line starts where the reader asked, not where the shift puts it.
    seek(Math.max(0, startTime - offset))
  }

  const lineStyle = (active: boolean): CSSProperties => ({
    fontSize: active
      ? Math.min(MAX_ACTIVE_FONT_SIZE, Math.round(preferences.fontSize * ACTIVE_LINE_SCALE))
      : preferences.fontSize,
    lineHeight: preferences.lineHeight,
    textAlign: preferences.align,
  })

  return (
    <Modal
      open={open}
      onClose={close}
      variant="fullscreen"
      ariaLabel={musicText('music.lyrics.title')}
      bodyClassName="music-nowplaying__body"
    >
      <div ref={rootRef} className="music-root relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {preferences.blurBackground && coverUrl && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div
              className="absolute inset-[-8%] scale-110 bg-cover bg-center opacity-40 blur-3xl"
              style={{ backgroundImage: `url(${JSON.stringify(coverUrl)})` }}
            />
            <div className="absolute inset-0 bg-[var(--bg-base)] opacity-80" />
          </div>
        )}

        <header className="relative z-10 flex shrink-0 items-start gap-3 px-4 pt-4 md:px-8">
          <div className="min-w-0 flex-1">
            <p className="text-[length:var(--text-10-5)] font-semibold tracking-[var(--tracking-section)] uppercase text-[var(--text-tertiary)]">
              {musicText('music.nowplaying.title')}
            </p>
            {current && (
              <>
                <h2 className="truncate text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
                  {current.title}
                </h2>
                <p className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                  {musicArtistNames(current)}
                </p>
              </>
            )}
          </div>
          <IconButton size="sm" label={musicText('music.lyrics.settings')} active={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>
            <Settings2 size={16} />
          </IconButton>
          <IconButton size="sm" label={musicText('common.close')} onClick={close}>
            <X size={17} />
          </IconButton>
        </header>

        <div
          ref={scrollRef}
          role="group"
          aria-label={musicText('music.lyrics.lines')}
          className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 md:px-10"
        >
          {!current && (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 text-center">
              <Music2 size={26} aria-hidden="true" className="text-[var(--text-quaternary)]" />
              <p className="music-lyrics__empty">{musicText('music.nowplaying.empty')}</p>
            </div>
          )}

          {current && lyric.status === 'loading' && (
            <div className="flex h-full min-h-[220px] items-center justify-center gap-2 text-[var(--text-tertiary)]">
              <Spinner size={15} />
              <span className="text-[length:var(--text-12)]">{musicText('music.lyrics.loading')}</span>
            </div>
          )}

          {current && lyric.status !== 'loading' && instrumental && (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 text-center">
              <Music2 size={26} aria-hidden="true" className="text-[var(--text-quaternary)]" />
              <p className="music-lyrics__empty">{musicText('music.lyrics.instrumental')}</p>
            </div>
          )}

          {current && lyric.status !== 'loading' && !instrumental && lyric.lines.length === 0 && (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 text-center">
              <Music2 size={26} aria-hidden="true" className="text-[var(--text-quaternary)]" />
              <p className="music-lyrics__empty" title={lyric.status === 'error' ? lyric.error ?? undefined : undefined}>
                {musicText(lyric.status === 'error' ? 'music.lyrics.error' : 'music.lyrics.empty')}
              </p>
              <button
                type="button"
                onClick={lyric.retry}
                className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--accent)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
              >
                <RefreshCw size={13} />
                {musicText('music.lyrics.retry')}
              </button>
            </div>
          )}

          {current && !instrumental && lyric.lines.map((line, index) => {
            const active = index === activeIndex
            const text = (
              <>
                <LyricLineContent
                  line={line}
                  timeMs={positionMs + offset}
                  offsetMs={offset}
                  playing={playing}
                  wordByWord={active && preferences.wordByWord}
                />
                {preferences.showTranslation && line.translation && (
                  <span className="music-lyrics__translation">{line.translation}</span>
                )}
              </>
            )
            const baseClass = cn(
              'music-lyrics__line block w-full rounded-[var(--r-sm)] px-2 py-1.5',
              'transition-colors duration-[var(--dur-base)] ease-[var(--ease-out)]',
              'motion-reduce:transition-none',
              active ? 'music-lyrics__line--current' : 'opacity-55 hover:opacity-90',
            )
            if (line.startTime < 0) {
              return (
                <p key={`label-${index}`} className={baseClass} style={lineStyle(active)}>
                  {text}
                </p>
              )
            }
            return (
              <button
                key={`${line.startTime}-${index}`}
                type="button"
                aria-current={active ? 'true' : undefined}
                data-lyric-active={active || undefined}
                onClick={() => seekToLine(line.startTime)}
                className={cn(
                  baseClass,
                  'cursor-pointer hover:bg-[var(--bg-hover)]',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                )}
                style={lineStyle(active)}
              >
                {text}
              </button>
            )
          })}
        </div>

        <QuietCommentLayer lines={lyric.lines} loaded={lyric.status !== 'loading'} className="z-20" />

        {settingsOpen && current && (
          <div className="relative z-10 max-h-[42%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            <LyricSettings />
          </div>
        )}

        {current && (
          <div className="relative z-10 flex shrink-0 flex-col gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 pt-3 pb-[calc(var(--sp-3)+env(safe-area-inset-bottom))] md:px-8">
            <div className="flex items-center gap-2">
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
              <span className="music-playbar__time music-playbar__time--end">
                {formatDuration(totalMs)}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Languages size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                <span className="text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                  {musicText('music.lyrics.translation')}
                </span>
                <Switch
                  checked={preferences.showTranslation}
                  label={musicText('music.lyrics.translation')}
                  onChange={(showTranslation) => setLyrics({ showTranslation })}
                />
              </div>

              <div className="flex items-center gap-2">
                <IconButton label={musicText('music.playbar.previous')} size="lg" onClick={() => { void prev() }}>
                  <SkipBack size={18} />
                </IconButton>
                <IconButton
                  className="music-playbar__play"
                  label={musicText(playing ? 'music.playbar.pause' : 'music.playbar.play')}
                  size="lg"
                  active={playing}
                  onClick={() => { void toggle() }}
                >
                  {playing ? <Pause size={18} /> : <Play size={18} />}
                </IconButton>
                <IconButton label={musicText('music.playbar.next')} size="lg" onClick={() => { void next() }}>
                  <SkipForward size={18} />
                </IconButton>
              </div>

              <LyricOffsetControls offset={offset} onChange={setOffset} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
