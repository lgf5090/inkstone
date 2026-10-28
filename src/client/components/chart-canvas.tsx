/**
 * One chart.js canvas, with the housekeeping every chart in the app shares.
 *
 * The library already ships for note charts, so this is the second caller of the same dependency rather
 * than a second rendering engine. Three things belong here and nowhere else: the import is deferred until
 * a chart is actually drawn (a reader who never opens a screen with a chart never downloads it), the
 * colours come from the accent and the theme through the one palette the note charts use, and the chart is
 * destroyed with its effect — one left behind keeps its resize observer and repaints off screen.
 *
 * The canvas is an image to a screen reader, so `label` has to say what the picture shows. A chart drawn
 * beside a list of the same numbers gets away with naming the picture; one that stands alone has to carry
 * the numbers in its label.
 */
import { useEffect, useRef } from 'react'
import type { ChartConfiguration, ChartType } from 'chart.js'
import { chartPalette } from '../lib/markdown/chart'
import { chartIdentityPalette } from '../lib/markdown/chart/accent'
import { useThemeDark } from '../lib/hooks'

export interface ChartColors {
  palette: string[]
  identities: string[]
  text: string
  grid: string
}

/** A translucent fill for an area series, from the opaque hex the palette hands out. */
export function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#') || color.length !== 7) return color
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
}

/**
 * `build` is memoised by the caller on the data it closes over, which is what makes this effect re-run when
 * the window or the grouping changes rather than on every render. `K` is read off that builder, so a caller
 * may hand back the chart-specific options its own type carries — a doughnut's `cutout` is not in the
 * shared option set, and widening the config to every chart type here would have thrown that away.
 */
export function ChartCanvas<K extends ChartType>({ height, label, build }: {
  height: string
  label: string
  build: (colors: ChartColors) => ChartConfiguration<K>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dark = useThemeDark()
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let chart: { destroy: () => void } | null = null
    let cancelled = false
    void import('chart.js/auto').then(({ default: Chart }) => {
      if (cancelled || !canvas.current) return
      const styles = getComputedStyle(document.documentElement)
      const colors: ChartColors = {
        palette: chartPalette(dark),
        identities: chartIdentityPalette(dark),
        text: styles.getPropertyValue('--text-quaternary').trim() || '#888',
        grid: dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
      }
      // Drawing is the one thing here that can fail on its own — a context that cannot be had, a library
      // that will not load — and the numbers above it are what the reader came for. Best-effort, then.
      try {
        chart = new Chart(canvas.current, build(colors))
      } catch {
        // A chart that refused to draw leaves its list of numbers beside it, which is the same answer.
        chart = null
      }
    })
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [build, dark])
  return (
    <div className={height}>
      <canvas ref={canvas} aria-label={label} role="img" />
    </div>
  )
}
