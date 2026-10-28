/** The recording waveform: a seekable bar strip that also answers the arrow keys. */
import { useEffect, useRef } from 'react'
import { cn } from '../../../lib/cn'

export function Waveform({ peaks, progress, label, onSeek, className }: {
  peaks: readonly number[]
  progress: number
  label: string
  onSeek: (fraction: number) => void
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    const width = canvas.clientWidth || 220
    const height = 28
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)
    const styles = getComputedStyle(document.documentElement)
    const played = styles.getPropertyValue('--accent').trim() || '#2563eb'
    const rest = styles.getPropertyValue('--border-strong').trim() || '#cbd5e1'
    const count = Math.max(1, peaks.length)
    const gap = 1
    const barWidth = Math.max(1, (width - gap * (count - 1)) / count)
    for (let index = 0; index < count; index += 1) {
      const value = Math.max(0.04, peaks[index] ?? 0)
      const barHeight = Math.max(2, value * (height - 4))
      context.fillStyle = index / count <= progress ? played : rest
      context.fillRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight)
    }
  }, [peaks, progress])

  const seek = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    onSeek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
  }

  return (
    <button
      type="button"
      aria-label={label}
      data-progress={Math.round(progress * 100)}
      onClick={seek}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onSeek(Math.max(0, progress - 0.05)) }
        if (event.key === 'ArrowRight') { event.preventDefault(); onSeek(Math.min(1, progress + 0.05)) }
      }}
      className={cn('block w-full rounded-[var(--r-xs)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none', className)}
    >
      <canvas ref={canvasRef} className="block h-7 w-full" aria-hidden="true"/>
    </button>
  )
}
