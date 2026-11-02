import { useEffect, useRef, useState } from 'react'
import { evaluateNode } from '@shared/tools/calculator/graphing/evaluate'
import { plotEquation } from '@shared/tools/calculator/graphing/plot'
import type { GraphNode } from '@shared/tools/calculator/graphing/parser'
import { GRAPH_COLORS, GRAPH_DEFAULT_VIEWPORT } from '@shared/tools/calculator/contract'
import type { GraphEquation, GraphLineStyle, GraphViewport, TrigMode } from '@shared/tools/calculator/types'
import { formatGraphNumber } from '@shared/tools/calculator/graphing/analyze'
import { useThemeDark } from '../../../../lib/hooks'
import { calcT } from '../lib/calc-i18n'

const DASH: Record<GraphLineStyle, number[]> = {
  solid: [],
  dot: [2, 5],
  dash: [8, 5],
  dash_dot: [8, 4, 2, 4],
  dash_dot_dot: [8, 4, 2, 4, 2, 4],
}

function niceStep(span: number): number {
  const raw = Math.abs(span) / 8
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const power = Math.floor(Math.log10(raw))
  const base = 10 ** power
  const normalized = raw / base
  const factor = normalized < 1.5 ? 1 : normalized < 3.5 ? 2 : normalized < 7.5 ? 5 : 10
  return factor * base
}

export function GraphCanvas({
  plots,
  viewport,
  variables,
  trigMode,
  lineWidth,
  theme,
  tracing,
  onViewportChange,
  onToggleTracing,
  onReady,
}: {
  plots: { equation: GraphEquation; node: GraphNode }[]
  viewport: GraphViewport
  variables: Record<string, number>
  trigMode: TrigMode
  lineWidth: number
  theme: 'light' | 'match_app'
  tracing: boolean
  onViewportChange: (viewport: GraphViewport) => void
  onToggleTracing: () => void
  onReady?: (canvas: HTMLCanvasElement | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 640, height: 480 })
  const appDark = useThemeDark()
  const actualTheme = theme === 'light' ? 'light' : appDark ? 'dark' : 'light'
  const [trace, setTrace] = useState<{ x: number; y: number; equationId: string } | null>(null)
  const dragRef = useRef<{ x: number; y: number; viewport: GraphViewport } | null>(null)

  useEffect(() => {
    onReady?.(canvasRef.current)
    return () => onReady?.(null)
  }, [onReady])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(element)
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(size.width))
    const height = Math.max(1, Math.floor(size.height))
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    const light = actualTheme === 'light'
    const background = light ? '#ffffff' : getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim() || '#151515'
    const foreground = light ? '#595959' : getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim() || '#a3a3a3'
    const axisColor = light ? '#8c8c8c' : getComputedStyle(document.documentElement).getPropertyValue('--border-strong').trim() || '#6a6a6a'
    const gridColor = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.09)'

    const xSpan = viewport.xMax - viewport.xMin
    const ySpan = viewport.yMax - viewport.yMin
    const toScreenX = (x: number) => ((x - viewport.xMin) / xSpan) * width
    const toScreenY = (y: number) => height - ((y - viewport.yMin) / ySpan) * height

    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    context.save()
    context.beginPath()
    context.rect(0, 0, width, height)
    context.clip()

    const stepX = niceStep(xSpan)
    const stepY = niceStep(ySpan)
    context.strokeStyle = gridColor
    context.lineWidth = 1
    context.beginPath()
    for (let x = Math.ceil(viewport.xMin / stepX) * stepX; x <= viewport.xMax; x += stepX) {
      const sx = toScreenX(x)
      context.moveTo(sx, 0)
      context.lineTo(sx, height)
    }
    for (let y = Math.ceil(viewport.yMin / stepY) * stepY; y <= viewport.yMax; y += stepY) {
      const sy = toScreenY(y)
      context.moveTo(0, sy)
      context.lineTo(width, sy)
    }
    context.stroke()

    context.strokeStyle = axisColor
    context.lineWidth = 1.2
    context.beginPath()
    if (viewport.xMin <= 0 && viewport.xMax >= 0) {
      const sx = toScreenX(0)
      context.moveTo(sx, 0)
      context.lineTo(sx, height)
    }
    if (viewport.yMin <= 0 && viewport.yMax >= 0) {
      const sy = toScreenY(0)
      context.moveTo(0, sy)
      context.lineTo(width, sy)
    }
    context.stroke()

    context.fillStyle = foreground
    context.font = '11px ui-sans-serif, system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    for (let x = Math.ceil(viewport.xMin / stepX) * stepX; x <= viewport.xMax; x += stepX) {
      if (Math.abs(x) < 1e-10) continue
      context.fillText(formatGraphNumber(x, 4), toScreenX(x), toScreenY(0) + 4)
    }
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (let y = Math.ceil(viewport.yMin / stepY) * stepY; y <= viewport.yMax; y += stepY) {
      if (Math.abs(y) < 1e-10) continue
      context.fillText(formatGraphNumber(y, 4), toScreenX(0) - 5, toScreenY(y))
    }

    for (const plot of plots) {
      const color = GRAPH_COLORS[plot.equation.colorIndex % GRAPH_COLORS.length]
      const geometry = plotEquation(plot.node, viewport, { width, height, variables, trigMode })
      if (geometry.cells.length > 0) {
        context.fillStyle = `${color}22`
        for (const cell of geometry.cells) {
          const sx = toScreenX(cell.x)
          const sy = toScreenY(cell.y + cell.height)
          context.fillRect(sx, sy, Math.max(1, (cell.width / xSpan) * width + 1), Math.max(1, (cell.height / ySpan) * height + 1))
        }
      }
      context.strokeStyle = color
      context.lineWidth = lineWidth
      context.setLineDash(DASH[plot.equation.lineStyle])
      context.lineJoin = 'round'
      context.lineCap = 'round'
      for (const curve of geometry.curves) {
        context.beginPath()
        let started = false
        for (const point of curve) {
          const sx = toScreenX(point.x)
          const sy = toScreenY(point.y)
          if (!started) {
            context.moveTo(sx, sy)
            started = true
          } else context.lineTo(sx, sy)
        }
        context.stroke()
      }
      if (geometry.segments.length > 0) {
        context.beginPath()
        for (const segment of geometry.segments) {
          context.moveTo(toScreenX(segment.x1), toScreenY(segment.y1))
          context.lineTo(toScreenX(segment.x2), toScreenY(segment.y2))
        }
        context.stroke()
      }
      context.setLineDash([])
    }

    if (trace) {
      const sx = toScreenX(trace.x)
      const sy = toScreenY(trace.y)
      context.strokeStyle = foreground
      context.lineWidth = 1
      context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(sx, 0)
      context.lineTo(sx, height)
      context.moveTo(0, sy)
      context.lineTo(width, sy)
      context.stroke()
      context.setLineDash([])
      context.fillStyle = foreground
      context.beginPath()
      context.arc(sx, sy, 4, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }, [plots, viewport, size, variables, trigMode, lineWidth, actualTheme, trace])

  const updateTrace = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tracing) {
      setTrace(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const x = viewport.xMin + (px / rect.width) * (viewport.xMax - viewport.xMin)
    let best: { x: number; y: number; equationId: string } | null = null
    let bestDistance = 20
    for (const plot of plots) {
      const y = evaluateNode(plot.node.kind === 'relation' ? plot.node.right : plot.node, { x, vars: variables, trigMode })
      if (!Number.isFinite(y)) continue
      const sy = rect.height - ((y - viewport.yMin) / (viewport.yMax - viewport.yMin)) * rect.height
      const distance = Math.abs(sy - py)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { x, y, equationId: plot.equation.id }
      }
    }
    setTrace(best)
  }

  return (
    <div ref={containerRef} className="relative h-full min-h-[280px] w-full touch-none overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)]">
      <canvas
        ref={canvasRef}
        data-testid="calculator-graph-canvas"
        tabIndex={0}
        aria-label={calcT('tools.calculator.a11y.graph_canvas')}
        className="block h-full w-full cursor-crosshair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { x: event.clientX, y: event.clientY, viewport }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag) {
            const rect = event.currentTarget.getBoundingClientRect()
            const dx = (event.clientX - drag.x) / rect.width
            const dy = (event.clientY - drag.y) / rect.height
            const xSpan = drag.viewport.xMax - drag.viewport.xMin
            const ySpan = drag.viewport.yMax - drag.viewport.yMin
            onViewportChange({
              xMin: drag.viewport.xMin - dx * xSpan,
              xMax: drag.viewport.xMax - dx * xSpan,
              yMin: drag.viewport.yMin + dy * ySpan,
              yMax: drag.viewport.yMax + dy * ySpan,
            })
            return
          }
          updateTrace(event)
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerCancel={() => { dragRef.current = null }}
        onPointerLeave={() => { dragRef.current = null; setTrace(null) }}
        onWheel={(event) => {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const px = (event.clientX - rect.left) / rect.width
          const py = 1 - (event.clientY - rect.top) / rect.height
          const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15
          const x = viewport.xMin + px * (viewport.xMax - viewport.xMin)
          const y = viewport.yMin + py * (viewport.yMax - viewport.yMin)
          onViewportChange({
            xMin: x - (x - viewport.xMin) * factor,
            xMax: x + (viewport.xMax - x) * factor,
            yMin: y - (y - viewport.yMin) * factor,
            yMax: y + (viewport.yMax - y) * factor,
          })
        }}
        onKeyDown={(event) => {
          const xStep = (viewport.xMax - viewport.xMin) / 20
          const yStep = (viewport.yMax - viewport.yMin) / 20
          if (event.key === 'ArrowLeft') { event.preventDefault(); onViewportChange({ ...viewport, xMin: viewport.xMin - xStep, xMax: viewport.xMax - xStep }) }
          else if (event.key === 'ArrowRight') { event.preventDefault(); onViewportChange({ ...viewport, xMin: viewport.xMin + xStep, xMax: viewport.xMax + xStep }) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); onViewportChange({ ...viewport, yMin: viewport.yMin + yStep, yMax: viewport.yMax + yStep }) }
          else if (event.key === 'ArrowDown') { event.preventDefault(); onViewportChange({ ...viewport, yMin: viewport.yMin - yStep, yMax: viewport.yMax - yStep }) }
          else if (event.key === '+' || event.key === '=') { event.preventDefault(); onViewportChange({ xMin: viewport.xMin * 0.9, xMax: viewport.xMax * 0.9, yMin: viewport.yMin * 0.9, yMax: viewport.yMax * 0.9 }) }
          else if (event.key === '-') { event.preventDefault(); onViewportChange({ xMin: viewport.xMin / 0.9, xMax: viewport.xMax / 0.9, yMin: viewport.yMin / 0.9, yMax: viewport.yMax / 0.9 }) }
          else if (event.key.toLowerCase() === 't') { event.preventDefault(); onToggleTracing() }
          else if (event.key === 'Home') { event.preventDefault(); onViewportChange({ ...GRAPH_DEFAULT_VIEWPORT }) }
        }}
      />
      {plots.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {calcT('tools.calculator.graph.graph_empty')}
        </div>
      )}
      {trace && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-[var(--r-sm)] bg-[var(--bg-overlay)]/90 px-2 py-1 text-[length:var(--text-11)] tabular-nums text-[var(--text-secondary)] shadow-sm">
          ({formatGraphNumber(trace.x, 4)}, {formatGraphNumber(trace.y, 4)})
        </div>
      )}
    </div>
  )
}
