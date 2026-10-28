/**
 * One karaoke line: its words, filled at the audio element's own clock.
 *
 * The line mounts only while it is the current one, so a single animation loop is enough for the
 * whole lyric list. The loop re-renders this line, not the list; each word's fill is a CSS custom
 * property, which keeps the visual work in the compositor. A reader who asked for less motion gets
 * the same text on the engine's four-hertz `timeupdate` instead of a frame loop.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { lyricWordStateAt, lyricWordTimings, type LyricLine } from '@shared/music/lyrics'
import { musicAudioEngine } from '../player/engine'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function KaraokeLine({
  line,
  timeMs,
  offsetMs = 0,
  playing,
}: {
  line: LyricLine
  timeMs: number
  offsetMs?: number
  playing: boolean
}): ReactElement {
  const fallback = useRef(timeMs)
  fallback.current = timeMs
  const [liveMs, setLiveMs] = useState(timeMs)
  const reduced = prefersReducedMotion()
  const timings = useMemo(() => lyricWordTimings(line), [line])

  useEffect(() => {
    if (!playing) {
      const engine = musicAudioEngine.currentTimeMs()
      setLiveMs(Number.isFinite(engine) && engine > 0 ? engine + offsetMs : fallback.current)
      return
    }
    if (reduced) {
      return musicAudioEngine.subscribe('timeupdate', ({ positionMs }) => setLiveMs(positionMs + offsetMs))
    }
    let frame = 0
    const tick = (): void => {
      const engine = musicAudioEngine.currentTimeMs()
      setLiveMs(Number.isFinite(engine) && engine > 0 ? engine + offsetMs : fallback.current)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [offsetMs, playing, reduced])

  if (!timings.words.length) return <>{line.fullText}</>
  const state = lyricWordStateAt(timings.words, liveMs)
  return (
    <>
      {timings.words.map((word, index) => {
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
