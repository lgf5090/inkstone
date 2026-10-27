/**
 * The player's progress row: elapsed time, a native range slider and total time.
 *
 * A drag is handed to the audio element as it moves (`immediate`), because the shared slider's frame
 * coalescing would otherwise swallow the last step when the reader lets go. The buffered overlay is
 * painted behind the range by the stylesheet; the range keeps its own keyboard and touch semantics.
 */
import type { CSSProperties, ReactElement } from 'react'
import { Slider } from '../../../components/form'
import { cn } from '../../../lib/cn'
import { formatDuration } from '@shared/music/format'
import { musicText } from '../components/labels'

export function NowPlayingScrubber({
  positionMs,
  durationMs,
  onSeek,
  bufferedFraction = 0,
  compact = false,
  className,
}: {
  positionMs: number
  durationMs: number
  onSeek: (positionMs: number) => void
  bufferedFraction?: number
  compact?: boolean
  className?: string
}): ReactElement {
  const total = Math.max(1, Math.round(durationMs / 1000))
  const position = Math.min(total, Math.max(0, Math.round(positionMs / 1000)))
  const buffered = Math.min(100, Math.max(0, Math.round(bufferedFraction * 100)))
  return (
    <div className={cn('music-np__progress', compact && 'music-np__progress--compact', className)}>
      <span className="music-np__time">{formatDuration(positionMs)}</span>
      <div className="music-np__scrubber" style={{ '--music-buffered': `${buffered}%` } as CSSProperties}>
        <Slider
          className="music-np__slider"
          label={musicText('music.playbar.progress')}
          value={position}
          min={0}
          max={total}
          step={1}
          suffix="s"
          immediate
          onChange={(value) => onSeek(value * 1000)}
        />
      </div>
      <span className="music-np__time music-np__time--end">{formatDuration(durationMs)}</span>
    </div>
  )
}
