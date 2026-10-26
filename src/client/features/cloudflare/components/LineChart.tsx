/**
 * A line chart drawn with SVG, because the app has no charting dependency.
 *
 * The traffic screen needs one figure: a value per hour (or per day) for one or two series. A chart
 * library would bring its own layout, its own colours and its own accessibility story for a shape
 * this small; here the colours are tokens, the figure carries a label, and the hover reading is a
 * positioned text block rather than a canvas.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/cn'

export interface LineChartPoint {
  label: string
  value: number
}

export interface LineChartSeries {
  label: string
  data: readonly LineChartPoint[]
  color: string
}

const FALLBACK_WIDTH = 560
const PAD_X = 10
const PAD_TOP = 8
const PAD_BOTTOM = 22
const MIN_HEIGHT = 80

export function LineChart({
  data,
  series: seriesProp,
  color = 'var(--chart-1)',
  height = 112,
  formatValue = (value: number) => String(value),
  maxTicks = 6,
  label,
  stretch = true,
  tooltip = true,
  area = true,
  verticalTicks = false,
  className,
}: {
  data?: readonly LineChartPoint[]
  series?: readonly LineChartSeries[]
  color?: string
  height?: number
  formatValue?: (value: number) => string
  maxTicks?: number
  label: string
  stretch?: boolean
  tooltip?: boolean
  area?: boolean
  verticalTicks?: boolean
  className?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const widthId = useId().replaceAll(':', '')
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    if (!stretch || !container.current) return
    const element = container.current
    const observer = new ResizeObserver(() => setWidth(Math.max(240, element.clientWidth)))
    observer.observe(element)
    setWidth(Math.max(240, element.clientWidth))
    return () => observer.disconnect()
  }, [stretch])

  const series = useMemo<readonly LineChartSeries[]>(
    () => seriesProp && seriesProp.length > 0
      ? seriesProp
      : [{ label, data: data ?? [], color }],
    [seriesProp, data, color, label],
  )
  const count = series.reduce((max, entry) => Math.max(max, entry.data.length), 0)
  const chartHeight = Math.max(MIN_HEIGHT, height)
  const plotHeight = chartHeight - PAD_TOP - PAD_BOTTOM
  const plotWidth = width - 2 * PAD_X
  const maxValue = Math.max(1, ...series.flatMap((entry) => entry.data.map((point) => point.value)))
  const xAt = (index: number) => PAD_X + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth)
  const yAt = (value: number) => PAD_TOP + (1 - value / maxValue) * plotHeight

  const tickStep = Math.max(1, Math.ceil(count / Math.max(1, maxTicks)))
  const ticks = series[0]?.data
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % tickStep === 0 || index === count - 1) ?? []

  if (count === 0) {
    return (
      <div className={cn('flex items-center justify-center text-[length:var(--text-12)] text-[var(--text-tertiary)]', className)} style={{ height: chartHeight }}>
        {label}
      </div>
    )
  }

  return (
    <div ref={container} className={cn('relative w-full', className)}>
      <svg
        width={stretch ? '100%' : width}
        height={chartHeight}
        viewBox={`0 0 ${width} ${chartHeight}`}
        role="img"
        aria-label={label}
        className="overflow-visible"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          if (!tooltip) return
          const rect = event.currentTarget.getBoundingClientRect()
          const scale = width / rect.width
          const x = (event.clientX - rect.left) * scale
          const index = count <= 1 ? 0 : Math.round(((x - PAD_X) / plotWidth) * (count - 1))
          setHover(Math.min(count - 1, Math.max(0, index)))
        }}
      >
        <defs>
          {series.map((entry, index) => (
            <linearGradient key={entry.label} id={`${widthId}-area-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={entry.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={entry.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1={PAD_X}
            x2={width - PAD_X}
            y1={PAD_TOP + ratio * plotHeight}
            y2={PAD_TOP + ratio * plotHeight}
            stroke="var(--border-subtle)"
            strokeDasharray={ratio === 1 ? undefined : '3 4'}
          />
        ))}
        {area && series.map((entry, index) => {
          if (entry.data.length === 0) return null
          const line = entry.data.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${xAt(pointIndex)},${yAt(point.value)}`).join(' ')
          const areaPath = `${line} L${xAt(entry.data.length - 1)},${PAD_TOP + plotHeight} L${xAt(0)},${PAD_TOP + plotHeight} Z`
          return <path key={`${entry.label}-area`} d={areaPath} fill={`url(#${widthId}-area-${index})`} />
        })}
        {series.map((entry) => (
          <path
            key={entry.label}
            d={entry.data.map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index)},${yAt(point.value)}`).join(' ')}
            fill="none"
            stroke={entry.color}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {hover !== null && (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD_TOP} y2={PAD_TOP + plotHeight} stroke="var(--border-strong)" strokeDasharray="2 3" />
        )}
        {hover !== null && series.map((entry) => entry.data[hover] && (
          <circle key={`${entry.label}-dot`} cx={xAt(hover)} cy={yAt(entry.data[hover]!.value)} r="2.6" fill={entry.color} stroke="var(--bg-base)" strokeWidth="1" />
        ))}
        {ticks.map(({ point, index }) => (
          <text
            key={`${point.label}-${index}`}
            x={xAt(index)}
            y={chartHeight - (verticalTicks ? 2 : 6)}
            textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}
            fontSize="9"
            fill="var(--text-quaternary)"
            transform={verticalTicks ? `rotate(-90 ${xAt(index)} ${chartHeight - 6})` : undefined}
          >
            {point.label}
          </text>
        ))}
      </svg>
      {tooltip && hover !== null && series[0]?.data[hover] && (
        <div
          className="pointer-events-none absolute top-1 z-[var(--z-pop)] rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 text-[length:var(--text-11)] shadow-[var(--shadow-pop)]"
          style={{ left: `${Math.min(80, Math.max(0, (xAt(hover) / width) * 100))}%` }}
        >
          <div className="text-[var(--text-tertiary)]">{series[0]!.data[hover]!.label}</div>
          {series.map((entry) => (
            <div key={entry.label} className="flex items-center gap-1.5 tabular-nums">
              <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ background: entry.color }} />
              <span className="text-[var(--text-tertiary)]">{entry.label}</span>
              <span className="text-[var(--text-primary)]">{formatValue(entry.data[hover]?.value ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
