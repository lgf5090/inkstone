import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import type { WebsshCastEvent, WebsshCastHeader } from '@shared/webssh/types'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Slider } from '../../components/form'
import { t } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import { loadTerminalSettings } from './prefs'
import { resolveTerminalTheme } from './terminal-themes'
import { useXterm } from './use-xterm'

export interface CastSlice {
  nextOffset: number
  complete: boolean
  frames: WebsshCastEvent[]
  header?: WebsshCastHeader
}

export interface CastPlayerProps {
  loadSlice: (offset: number, limit: number) => Promise<CastSlice>
  durationMs: number
  autoPlay?: boolean
  /** A moment an AI search pointed at; the player opens paused there instead of at the start. */
  initialSeekMs?: number | null
}

const SLICE_BYTES = 512 * 1024
const MAX_SLICES = 200

function seconds(value: number): string {
  const total = Math.max(0, Math.round(value))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function CastPlayer({ loadSlice, durationMs, autoPlay = true, initialSeekMs = null }: CastPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const eventsRef = useRef<WebsshCastEvent[]>([])
  const indexRef = useRef(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const frameRef = useRef(0)
  const writeRef = useRef<(data: string) => void>(() => {})

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(autoPlay)
  const [time, setTime] = useState(0)
  const [slices, setSlices] = useState(0)

  const settings = useMemo(() => loadTerminalSettings(), [])
  const isDark = useThemeDark()
  const theme = useMemo(() => resolveTerminalTheme(settings.theme, isDark), [settings.theme, isDark])

  const xterm = useXterm(containerRef, {
    theme,
    fontSize: settings.fontSize,
    cursorBlink: false,
    onInput: () => undefined,
    onResize: () => undefined,
    onSelectionChange: () => undefined,
    onCopyRequest: () => undefined,
    onPasteRequest: () => undefined,
    onClearRequest: () => undefined,
  })
  writeRef.current = xterm.write

  useEffect(() => {
    let cancelled = false
    eventsRef.current = []
    indexRef.current = 0
    timeRef.current = 0
    setLoading(true)
    setError(null)
    void (async () => {
      let offset = 0
      let count = 0
      try {
        for (;;) {
          const slice = await loadSlice(offset, SLICE_BYTES)
          if (cancelled) return
          eventsRef.current.push(...slice.frames)
          setSlices((value) => value + 1)
          count += 1
          if (slice.complete || slice.nextOffset <= offset || count >= MAX_SLICES) break
          offset = slice.nextOffset
        }
        setLoading(false)
      } catch (caught) {
        if (cancelled) return
        setLoading(false)
        setError(caught instanceof Error ? caught.message : t('webssh.replay.load_failed'))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadSlice])

  const draw = (targetSeconds: number) => {
    xterm.clear()
    indexRef.current = 0
    const events = eventsRef.current
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!
      if (event[0] > targetSeconds) break
      if (event[1] === 'o') writeRef.current(event[2])
      indexRef.current = index + 1
    }
    timeRef.current = targetSeconds
    setTime(targetSeconds)
  }

  useEffect(() => {
    if (loading || error) return
    if (!playing) {
      cancelAnimationFrame(frameRef.current)
      playingRef.current = false
      return
    }
    playingRef.current = true
    const startedAt = performance.now()
    const base = timeRef.current
    const total = durationMs / 1000
    const tick = () => {
      if (!playingRef.current) return
      const target = base + (performance.now() - startedAt) / 1000
      const events = eventsRef.current
      while (indexRef.current < events.length) {
        const event = events[indexRef.current]!
        if (event[0] > target) break
        if (event[1] === 'o') writeRef.current(event[2])
        indexRef.current += 1
      }
      const shown = Math.min(target, total)
      timeRef.current = shown
      setTime(shown)
      if (shown >= total) {
        playingRef.current = false
        setPlaying(false)
        return
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [loading, error, playing, durationMs])

  // The AI search's timestamp is applied once the slices are in memory: drawing before then would
  // start from an empty event list and show a blank terminal at the right second.
  useEffect(() => {
    if (loading || error || initialSeekMs === null) return
    setPlaying(false)
    playingRef.current = false
    draw(Math.min(durationMs / 1000, Math.max(0, initialSeekMs / 1000)))
  }, [loading, error, initialSeekMs, durationMs])

  const seek = (value: number) => {
    setPlaying(false)
    playingRef.current = false
    draw(value)
  }

  const replay = () => {
    draw(0)
    setPlaying(true)
  }

  const total = Math.max(1, durationMs / 1000)

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex min-h-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-editor)]">
        {loading ? (
          <div className="flex items-center gap-2 py-16"><Spinner size={16} /><span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('webssh.replay.loading')}</span></div>
        ) : error ? (
          <p className="p-6 text-[length:var(--text-12-5)] text-[var(--danger)]">{error}</p>
        ) : (
          <div ref={containerRef} className="webssh-terminal h-[52vh] w-full px-2 py-1" />
        )}
      </div>
      {!loading && !error && (
        <div className="flex flex-wrap items-center gap-2">
          <IconButton
            label={playing ? t('webssh.replay.pause') : t('webssh.replay.play')}
            size="sm"
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </IconButton>
          <IconButton label={t('webssh.replay.restart')} size="sm" onClick={replay}>
            <RotateCcw size={14} aria-hidden="true" />
          </IconButton>
          <span className="tabular shrink-0 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {seconds(time)} / {seconds(total)}
          </span>
          <div className="min-w-[160px] flex-1">
            <Slider
              value={Math.min(time, total)}
              min={0}
              max={total}
              step={0.1}
              onChange={seek}
              label={t('webssh.replay.seek')}
              immediate
            />
          </div>
          <Button size="sm" variant="ghost" onClick={() => seek(total)}>{t('webssh.replay.end')}</Button>
          <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('webssh.replay.slices', { count: slices })}
          </span>
        </div>
      )}
    </div>
  )
}
