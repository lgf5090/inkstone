/**
 * The lyric surface shared by the side panel and the full-screen layer.
 *
 * A lyric is read once per track, merged with its translation, then drawn from the player's own
 * position. The only persisted state is the per-track offset: translation and appearance belong to
 * `useMusicSettings`, and the active line is derived rather than stored.
 *
 * A track with no lyric is a normal answer, not a failed request. The panel says so and playback
 * carries on; only a transport or provider failure offers a retry.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { Languages, Maximize2, Minus, Music2, Plus, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import {
  findActiveLineIndex,
  lyricWordStateAt,
  lyricWordTimings,
  mergeLyricTranslation,
  parseLyrics,
  type LyricLine,
} from '@shared/music/lyrics'
import type { MusicAiTranslatedLine } from '@shared/music/lyrics-ai'
import { musicTrackKey, type MusicTrack } from '@shared/music/model'
import type { MusicLyricResponse } from '@shared/music/api'
import { ApiError } from '../../../lib/api'
import { cn } from '../../../lib/cn'
import { IS_DEMO_MODE } from '../../../lib/runtime'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { musicApi } from '../api'
import { defaultLyricTranslationLang, translateTrackLyrics } from '../lyrics-ai'
import { selectCurrentTrack, useMusicPlayer } from '../store/player'
import { musicAudioEngine } from '../player/engine'
import { useMusicSettings } from '../store/settings'
import { useMusicUi } from '../store/ui'
import { LyricSettings } from './LyricSettings'
import { musicText } from './labels'

export const MUSIC_LYRIC_OFFSET_LIMIT_MS = 10_000
export const MUSIC_LYRIC_OFFSET_STEP_MS = 1_000

const OFFSET_STORAGE_PREFIX = IS_DEMO_MODE
  ? 'inkstone.demo.music.lyricOffset.'
  : 'inkstone.music.lyricOffset.'

export type MusicLyricStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MusicLyricDocument {
  lines: LyricLine[]
  status: MusicLyricStatus
  error: string | null
  /** Whether the provider supplied a translation line of its own; the AI action only fills a gap. */
  providerTranslation: boolean
  retry: () => void
  /**
   * Merge translated lines into the current document. Lines the provider already translated are left
   * alone unless their timestamp is in `replace`, which is how a regenerated AI translation replaces
   * the previous AI one without touching the provider's.
   */
  mergeTranslation: (translated: readonly MusicAiTranslatedLine[], replace?: ReadonlySet<number>) => void
}

/**
 * The timed text a provider answer stands for.
 *
 * YRC carries per-word timing and is preferred when present; LRC is the fallback for tracks that only
 * have line timing. A provider may include both, and picking one here keeps the parser from seeing a
 * doubled document.
 */
export function lyricTextOf(answer: Pick<MusicLyricResponse, 'lrc' | 'yrc'>): string {
  return answer.yrc.trim() ? answer.yrc : answer.lrc
}

/** Clamp an offset to the range the panel offers, so a stale record cannot move a lyric off-screen. */
export function clampLyricOffset(offsetMs: number): number {
  if (!Number.isFinite(offsetMs)) return 0
  return Math.min(MUSIC_LYRIC_OFFSET_LIMIT_MS, Math.max(-MUSIC_LYRIC_OFFSET_LIMIT_MS, Math.round(offsetMs)))
}

export function lyricOffsetStorageKey(trackKey: string): string {
  return `${OFFSET_STORAGE_PREFIX}${trackKey}`
}

export function readLyricOffset(trackKey: string): number {
  if (!trackKey || typeof localStorage === 'undefined') return 0
  try {
    const raw = localStorage.getItem(lyricOffsetStorageKey(trackKey))
    if (!raw) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampLyricOffset(parsed) : 0
  } catch {
    // Storage can be denied or full; an offset that does not persist is still usable this session.
    return 0
  }
}

export function writeLyricOffset(trackKey: string, offsetMs: number): void {
  if (!trackKey || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(lyricOffsetStorageKey(trackKey), String(clampLyricOffset(offsetMs)))
  } catch {
    // Private mode and a full quota land here. The lyric still moves for this session.
  }
}

/** The active line at a position the offset has shifted; -1 before the first timed line. */
export function activeLyricLine(lines: readonly LyricLine[], positionMs: number, offsetMs: number): number {
  return findActiveLineIndex(lines, positionMs + offsetMs)
}

/**
 * Follow the audio element itself while a line is on screen.
 *
 * `timeupdate` arrives about four times a second, which is enough for a progress bar and far too
 * slow for a word that may last 120 ms. The store still owns the position for the rest of the app;
 * this hook samples the engine on animation frames and re-renders only when the active line changes.
 */
export function useActiveLyricLine(
  lines: readonly LyricLine[],
  positionMs: number,
  offsetMs: number,
  playing: boolean,
): number {
  const fallback = positionMs + offsetMs
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback
  const [liveIndex, setLiveIndex] = useState<number | null>(null)

  useEffect(() => {
    setLiveIndex(null)
    if (!playing || typeof requestAnimationFrame !== 'function') return
    let frame = 0
    let last = findActiveLineIndex(lines, fallbackRef.current)
    const tick = (): void => {
      const engineMs = musicAudioEngine.currentTimeMs()
      if (Number.isFinite(engineMs) && engineMs > 0) {
        const next = findActiveLineIndex(lines, engineMs + offsetMs)
        if (next !== last) {
          last = next
          setLiveIndex(next)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [lines, offsetMs, playing])

  return playing && liveIndex !== null ? liveIndex : findActiveLineIndex(lines, fallback)
}

/**
 * The same clock for the line's own words, which need roughly sixty updates a second.
 *
 * The hook reads `currentTime` from the audio element rather than the store so a word starts within
 * one frame of the singer. When no element is sounding (paused, tests, a restored queue) it falls
 * back to the position the parent already has.
 */
function useWordPlayhead(timeMs: number, offsetMs: number, enabled: boolean): number {
  const fallbackRef = useRef(timeMs)
  fallbackRef.current = timeMs
  const [liveMs, setLiveMs] = useState(timeMs)

  useEffect(() => {
    if (!enabled || typeof requestAnimationFrame !== 'function') {
      setLiveMs(fallbackRef.current)
      return
    }
    let frame = 0
    let last = Number.NaN
    const tick = (): void => {
      const engineMs = musicAudioEngine.currentTimeMs()
      const next = Number.isFinite(engineMs) && engineMs > 0
        ? engineMs + offsetMs
        : fallbackRef.current
      if (!Number.isFinite(last) || Math.abs(next - last) >= 8) {
        last = next
        setLiveMs(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [enabled, offsetMs])

  if (enabled) return liveMs
  // A pause can arrive between two four-hertz `timeupdate`s; read the element once so the frozen
  // fill is where the reader actually stopped rather than up to a quarter second behind it.
  const pausedMs = musicAudioEngine.currentTimeMs()
  return Number.isFinite(pausedMs) && pausedMs > 0 ? pausedMs + offsetMs : timeMs
}

/** A signed, one-decimal description of an offset, used beside the controls and in the aria text. */
export function formatLyricOffset(offsetMs: number): string {
  const seconds = clampLyricOffset(offsetMs) / 1000
  if (seconds === 0) return '0.0s'
  return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}s`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read and merge one track's lyric.
 *
 * The effect clears the previous document before loading the next one. Keeping the old lines visible
 * while a new request is in flight would highlight a line the new track never had.
 */
export function useTrackLyrics(track: MusicTrack | null): MusicLyricDocument {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [status, setStatus] = useState<MusicLyricStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [providerTranslation, setProviderTranslation] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const trackId = track?.id ?? null

  useEffect(() => {
    if (!trackId) {
      setLines([])
      setStatus('idle')
      setError(null)
      setProviderTranslation(false)
      return
    }
    let active = true
    setLines([])
    setStatus('loading')
    setError(null)
    setProviderTranslation(false)
    musicApi.lyrics(trackId)
      .then((answer) => {
        if (!active) return
        const parsed = parseLyrics(lyricTextOf(answer))
        const next = parsed.ok ? mergeLyricTranslation(parsed.data.lines, answer.tlyric) : []
        setLines(next)
        setStatus('ready')
        setError(parsed.ok ? null : parsed.error)
        setProviderTranslation(next.some((line) => Boolean(line.translation) && line.startTime >= 0))
      })
      .catch((reason: unknown) => {
        if (!active) return
        // A provider without a lyric answers 404. That is an empty result, not a broken panel.
        if (reason instanceof ApiError && reason.status === 404) {
          setLines([])
          setStatus('ready')
          setError(null)
          return
        }
        setLines([])
        setStatus('error')
        setError(describe(reason))
      })
    return () => {
      active = false
    }
  }, [reloadKey, trackId])

  const retry = useCallback(() => setReloadKey((value) => value + 1), [])

  /**
   * Attach AI translations by timestamp, falling back to line order when the counts agree.
   *
   * The rounded timestamp is the same join `mergeLyricTranslation` uses: LRC carries centiseconds, so
   * a provider line at 1002 ms and its cached translation at 1000 ms are the same line.
   */
  const mergeTranslation = useCallback((translated: readonly MusicAiTranslatedLine[], replace?: ReadonlySet<number>) => {
    if (!translated.length) return
    const byTime = new Map<number, string>()
    for (const line of translated) byTime.set(Math.round(line.startTime / 100) * 100, line.text)
    setLines((previous) => {
      const timed = previous.filter((line) => line.startTime >= 0 && line.fullText.trim())
      let timedIndex = 0
      return previous.map((line) => {
        if (line.startTime < 0 || !line.fullText.trim()) return line
        const index = timedIndex++
        const at = Math.round(line.startTime / 100) * 100
        const text = byTime.get(at) ?? (translated.length === timed.length ? translated[index]?.text : undefined)
        if (!text) return line
        if (line.translation && !replace?.has(at)) return line
        return { ...line, translation: text }
      })
    })
  }, [])

  return { lines, status, error, providerTranslation, retry, mergeTranslation }
}

/** The persisted offset for one track, reloaded when the track changes. */
export function useLyricOffset(track: MusicTrack | null): [number, (next: number) => void] {
  const trackKey = track ? musicTrackKey(track.provider, track.providerId) : ''
  const [offset, setOffsetState] = useState(() => readLyricOffset(trackKey))

  useEffect(() => {
    setOffsetState(readLyricOffset(trackKey))
  }, [trackKey])

  const setOffset = useCallback((next: number) => {
    const clamped = clampLyricOffset(next)
    setOffsetState(clamped)
    writeLyricOffset(trackKey, clamped)
  }, [trackKey])

  return [offset, setOffset]
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useActiveLineScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  activeIndex: number,
): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container || activeIndex < 0) return
    const active = container.querySelector<HTMLElement>('[data-lyric-active="true"]')
    // A browser without the method (or a test environment) simply leaves the list where it is.
    active?.scrollIntoView?.({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [activeIndex, containerRef])
}

/** One line's text, filled word by word at the audio element's own clock. */
export function LyricLineContent({
  line,
  timeMs,
  wordByWord,
  offsetMs = 0,
  playing = false,
}: {
  line: LyricLine
  timeMs: number
  wordByWord: boolean
  offsetMs?: number
  playing?: boolean
}): ReactElement {
  const liveMs = useWordPlayhead(timeMs, offsetMs, wordByWord && playing)
  // Estimated timings are recomputed only when the line changes, not on every animation frame.
  const timings = useMemo(() => (wordByWord ? lyricWordTimings(line) : null), [line, wordByWord])
  if (!wordByWord || !timings) return <>{line.fullText}</>
  // Provider YRC when it exists; otherwise the line box is shared out into an estimated rhythm, and
  // the panel says so rather than letting it pass for the provider's own timing.
  const { words } = timings
  if (!words.length) return <>{line.fullText}</>
  const state = lyricWordStateAt(words, liveMs)
  return (
    <>
      {words.map((word, index) => {
        const phase = index < state.index
          ? 'music-lyric-word--sung'
          : index === state.index
            ? 'music-lyric-word--singing'
            : 'music-lyric-word--pending'
        const style = index === state.index
          ? ({ '--music-word-progress': `${(state.progress * 100).toFixed(1)}%` } as CSSProperties)
          : undefined
        return (
          <span key={`${index}-${word.startTime}`} className={`music-lyric-word ${phase}`} style={style}>
            {word.text}
            {word.space ? ' ' : ''}
          </span>
        )
      })}
    </>
  )
}

function LyricTranslation({ line }: { line: LyricLine }): ReactElement | null {
  if (!line.translation) return null
  return <span className="music-lyrics__translation">{line.translation}</span>
}

/** The shared offset controls: two steps, the value and a reset once the value is not zero. */
export function LyricOffsetControls({
  offset,
  onChange,
  className,
}: {
  offset: number
  onChange: (next: number) => void
  className?: string
}): ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} role="group" aria-label={musicText('music.lyrics.offset')}>
      <IconButton
        size="xs"
        label={musicText('music.lyrics.offset_decrease')}
        disabled={offset <= -MUSIC_LYRIC_OFFSET_LIMIT_MS}
        onClick={() => onChange(offset - MUSIC_LYRIC_OFFSET_STEP_MS)}
      >
        <Minus size={13} />
      </IconButton>
      <span aria-live="polite" className="min-w-[44px] text-center text-[length:var(--text-11)] tabular-nums text-[var(--text-secondary)]">
        {formatLyricOffset(offset)}
      </span>
      <IconButton
        size="xs"
        label={musicText('music.lyrics.offset_increase')}
        disabled={offset >= MUSIC_LYRIC_OFFSET_LIMIT_MS}
        onClick={() => onChange(offset + MUSIC_LYRIC_OFFSET_STEP_MS)}
      >
        <Plus size={13} />
      </IconButton>
      {offset !== 0 && (
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onChange(0)}>
          {musicText('music.lyrics.offset_reset')}
        </Button>
      )}
    </div>
  )
}

function LyricEmpty({
  status,
  noTrack,
  error,
  onRetry,
}: {
  status: MusicLyricStatus
  noTrack: boolean
  error: string | null
  onRetry: () => void
}): ReactElement {
  const key = noTrack
    ? 'music.lyrics.no_track'
    : status === 'error'
      ? 'music.lyrics.error'
      : 'music.lyrics.empty'
  return (
    <div className="flex min-h-[180px] flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <Music2 size={22} aria-hidden="true" className="text-[var(--text-quaternary)]" />
      <p className="music-lyrics__empty" title={status === 'error' ? error ?? undefined : undefined}>
        {musicText(key)}
      </p>
      {!noTrack && (
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRetry}>
          {musicText('music.lyrics.retry')}
        </Button>
      )}
    </div>
  )
}

export interface LyricPanelProps {
  /** Defaults to the playing track; pass null to render an idle panel. */
  track?: MusicTrack | null
  /** `side` is a fixed right column, `embedded` fills whatever box the page gives it. */
  variant?: 'side' | 'embedded'
  className?: string
}

export function LyricPanel({ track, variant = 'embedded', className }: LyricPanelProps): ReactElement {
  const current = useMusicPlayer(selectCurrentTrack)
  const resolved = track === undefined ? current : track
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const playing = useMusicPlayer((state) => state.status === 'playing')
  const seek = useMusicPlayer((state) => state.seek)
  const setLyricsOpen = useMusicUi((state) => state.setLyricsOpen)
  const preferences = useMusicSettings((state) => state.local.lyrics)
  const setLyrics = useMusicSettings((state) => state.setLyrics)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lyric = useTrackLyrics(resolved)
  const [offset, setOffset] = useLyricOffset(resolved)
  const activeIndex = useActiveLyricLine(lyric.lines, positionMs, offset, playing)
  useActiveLineScroll(scrollRef, activeIndex)
  const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiModel, setAiModel] = useState('')
  // The timestamps this session's AI translation wrote. Regenerating replaces those lines and leaves
  // a provider translation — which may cover only some lines — untouched.
  const aiAppliedRef = useRef<Set<number>>(new Set())
  const mergeTranslation = lyric.mergeTranslation
  const trackId = resolved?.id ?? null
  // Read during the request's own await: a translation that lands after the reader changed track
  // belongs to the track it was asked for, not to the lines now on screen.
  const trackIdRef = useRef<string | null>(trackId)
  trackIdRef.current = trackId

  useEffect(() => {
    setAiStatus('idle')
    setAiError(null)
    setAiModel('')
    aiAppliedRef.current = new Set()
  }, [trackId])

  // A lyric reload starts from the provider's document again; the previous AI layer is gone with it.
  useEffect(() => {
    if (lyric.status === 'ready') return
    setAiStatus('idle')
    setAiError(null)
    aiAppliedRef.current = new Set()
  }, [lyric.status])

  const requestAiTranslation = useCallback(async (force: boolean) => {
    if (!resolved) return
    const requestedTrack = resolved.id
    setAiStatus('loading')
    setAiError(null)
    try {
      const answer = await translateTrackLyrics(requestedTrack, defaultLyricTranslationLang(), force)
      if (trackIdRef.current !== requestedTrack) return
      mergeTranslation(answer.lines, aiAppliedRef.current)
      aiAppliedRef.current = new Set(answer.lines.map((line) => Math.round(line.startTime / 100) * 100))
      setAiModel(answer.model)
      setAiStatus('ready')
      // The action exists to show the translation; making the reader find the separate toggle first
      // would hide the result of the call they just made.
      if (!preferences.showTranslation) setLyrics({ showTranslation: true })
    } catch (reason) {
      if (trackIdRef.current !== requestedTrack) return
      // The panel keeps the provider lyric visible and offers the same action again; the failure
      // line is the panel's own words and the server's detail stays in its title.
      setAiStatus('error')
      setAiError(describe(reason))
    }
  }, [mergeTranslation, preferences.showTranslation, resolved, setLyrics])

  const hasTimedLines = lyric.lines.some((line) => line.startTime >= 0 && line.fullText.trim())
  const offerAiTranslation = lyric.status === 'ready'
    && hasTimedLines
    && !lyric.providerTranslation
  const estimatedRhythm = preferences.wordByWord
    && lyric.lines.some((line) => line.startTime >= 0 && line.fullText.trim() && line.words.length === 0)

  const lineStyle: CSSProperties = {
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    textAlign: preferences.align,
  }
  const shiftedTime = positionMs + offset

  const seekToLine = (line: LyricLine): void => {
    if (line.startTime < 0) return
    // Undo the offset: the reader asked for this line, not for where the offset currently puts it.
    seek(Math.max(0, line.startTime - offset))
  }

  return (
    <section
      aria-label={musicText('music.lyrics.panel')}
      className={cn(
        'flex min-h-0 flex-col bg-[var(--bg-sunken)] text-[var(--text-primary)]',
        variant === 'side'
          ? 'h-full w-[320px] shrink-0 border-l border-[var(--border-subtle)]'
          : 'flex-1',
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-12)] font-semibold tracking-[var(--tracking-section)] uppercase text-[var(--text-tertiary)]">
          {musicText('music.lyrics.title')}
        </h2>
        <IconButton
          size="xs"
          label={musicText('music.lyrics.settings')}
          active={settingsOpen}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Settings2 size={14} />
        </IconButton>
        <IconButton
          size="xs"
          label={musicText('music.lyrics.fullscreen')}
          disabled={!resolved}
          onClick={() => setLyricsOpen(true)}
        >
          <Maximize2 size={14} />
        </IconButton>
      </header>

      {settingsOpen && <LyricSettings className="shrink-0 border-b border-[var(--border-subtle)]" />}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-4"
        role="group"
        aria-label={musicText('music.lyrics.lines')}
      >
        {lyric.status === 'loading' && (
          <div className="flex min-h-[160px] items-center justify-center gap-2 text-[var(--text-tertiary)]">
            <Spinner size={14} />
            <span className="text-[length:var(--text-12)]">{musicText('music.lyrics.loading')}</span>
          </div>
        )}

        {lyric.status !== 'loading' && lyric.lines.length === 0 && (
          <LyricEmpty
            status={lyric.status}
            noTrack={!resolved}
            error={lyric.error}
            onRetry={lyric.retry}
          />
        )}

        {lyric.lines.map((line, index) => {
          const active = index === activeIndex
          const opacity = active ? undefined : 'opacity-60 hover:opacity-100'
          const content: ReactNode = (
            <>
              <LyricLineContent
                line={line}
                timeMs={shiftedTime}
                offsetMs={offset}
                playing={playing}
                wordByWord={active && preferences.wordByWord}
              />
              {preferences.showTranslation && <LyricTranslation line={line} />}
            </>
          )
          if (line.startTime < 0) {
            return (
              <p key={`label-${index}`} className={cn('music-lyrics__line px-1 py-1.5', opacity)} style={lineStyle}>
                {content}
              </p>
            )
          }
          return (
            <button
              key={`${line.startTime}-${index}`}
              type="button"
              aria-current={active ? 'true' : undefined}
              data-lyric-active={active || undefined}
              onClick={() => seekToLine(line)}
              className={cn(
                'music-lyrics__line block w-full cursor-pointer rounded-[var(--r-sm)] px-1 py-1.5',
                'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                'hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2',
                'focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                active ? 'music-lyrics__line--current' : opacity,
              )}
              style={lineStyle}
            >
              {content}
            </button>
          )
        })}
      </div>

      <footer className="shrink-0 border-t border-[var(--border-subtle)] px-2 py-1.5">
        <div className="flex flex-col gap-1">
          {offerAiTranslation && (
            <div className="flex flex-wrap items-center gap-1.5">
              {aiStatus === 'ready' ? (
                <>
                  <span
                    className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
                    title={aiModel ? `${musicText('music.lyrics.ai_badge')} · ${aiModel}` : musicText('music.lyrics.ai_badge')}
                  >
                    <Sparkles size={12} aria-hidden="true" />
                    {musicText('music.lyrics.ai_badge')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => void requestAiTranslation(true)}
                  >
                    {musicText('music.lyrics.ai_regenerate')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  loading={aiStatus === 'loading'}
                  disabled={aiStatus === 'loading'}
                  icon={<Sparkles size={12} />}
                  title={musicText('music.lyrics.ai_privacy')}
                  onClick={() => void requestAiTranslation(aiStatus === 'error')}
                >
                  {aiStatus === 'loading'
                    ? musicText('music.lyrics.ai_translating')
                    : aiStatus === 'error'
                      ? musicText('music.lyrics.ai_retry')
                      : musicText('music.lyrics.ai_translate')}
                </Button>
              )}
              {aiStatus === 'error' && (
                <span
                  role="alert"
                  title={aiError ?? undefined}
                  className="text-[length:var(--text-11)] text-[var(--text-secondary)]"
                >
                  {musicText('music.lyrics.ai_failed')}
                </span>
              )}
            </div>
          )}
          {estimatedRhythm && (
            <p
              className="px-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]"
              title={musicText('music.lyrics.estimated_hint')}
            >
              {musicText('music.lyrics.estimated_rhythm')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <IconButton
              size="xs"
              label={musicText('music.lyrics.translation')}
              active={preferences.showTranslation}
              aria-pressed={preferences.showTranslation}
              onClick={() => setLyrics({ showTranslation: !preferences.showTranslation })}
            >
              <Languages size={14} />
            </IconButton>
            <LyricOffsetControls offset={offset} onChange={setOffset} className="ml-auto" />
          </div>
        </div>
      </footer>
    </section>
  )
}
