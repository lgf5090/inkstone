import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Download, Maximize2, Minus, Plus } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { IconButton, Spinner } from '../../../components/primitives'
import { Tooltip } from '../../../components/overlay'
import type { FlowEdgeDef, FlowNodeLayout } from './flow-layout'

export type { FlowEdgeDef, FlowNodeLayout } from './flow-layout'

export interface FlowExportNode {
  title: string
  lines: string[]
  highlightLines?: Set<number>
}

export interface SvgFlowProps {
  nodes: FlowNodeLayout[]
  edges: FlowEdgeDef[]
  renderNode: (id: string) => ReactNode
  nodeLabel?: (id: string) => string
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  onNodesChange?: (id: string, x: number, y: number) => void
  onNodeContextMenu?: (id: string, point: { x: number; y: number }) => void
  exportNode?: (id: string) => FlowExportNode | null
  exportName?: string
  onError?: (message: string) => void
  className?: string
}

interface Viewport {
  x: number
  y: number
  zoom: number
}

interface DragState {
  mode: 'pan' | 'node'
  startX: number
  startY: number
  origin: Viewport
  nodeId?: string
  nodeStart?: { x: number; y: number }
}

interface EdgeGeometry {
  d: string
  labelX: number
  labelY: number
}

interface FlowPalette {
  accent: string
  border: string
  surface: string
  text: string
  muted: string
  background: string
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.2
const FIT_PADDING = 40
const FIT_MAX_ZOOM = 1.2
const FIT_MIN_ZOOM = 0.02
const NODE_NUDGE = 12
const NODE_NUDGE_FINE = 1
const MINIMAP_WIDTH = 120
const MINIMAP_MIN_HEIGHT = 40
const MINIMAP_MIN_NODE_PX = 2
const EXPORT_PADDING = 24
const EXPORT_MIN_WIDTH = 320
const EXPORT_MIN_HEIGHT = 200
const EXPORT_HEADER_HEIGHT = 28
const EXPORT_ROW_HEIGHT = 19
const EXPORT_HEADER_BASELINE = 18
const EXPORT_FIRST_ROW_BASELINE = 41
const EXPORT_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const ARROW_MARKER_ID = 'arrow'
const EXPORT_REVOKE_DELAY_MS = 1_000
const COLOR_FALLBACK = {
  accent: '#8b5cf6',
  border: '#e4e4e7',
  surface: '#ffffff',
  text: '#18181b',
  muted: '#71717a',
  background: '#ffffff',
} as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function edgeGeometry(source: FlowNodeLayout, target: FlowNodeLayout): EdgeGeometry {
  if (source.id === target.id) {
    const x = source.x + source.width
    const y = source.y + source.height / 2
    return {
      d: `M ${x} ${y} C ${x + 56} ${y - 44}, ${x + 56} ${y + 44}, ${x} ${y + 18}`,
      labelX: x + 34,
      labelY: y - 24,
    }
  }
  const forward = target.x >= source.x
  const x1 = forward ? source.x + source.width : source.x
  const y1 = source.y + source.height / 2
  const x2 = forward ? target.x : target.x + target.width
  const y2 = target.y + target.height / 2
  const curve = Math.max(24, Math.abs(x2 - x1) * 0.4)
  const control1 = forward ? x1 + curve : x1 - curve
  const control2 = forward ? x2 - curve : x2 + curve
  return {
    d: `M ${x1} ${y1} C ${control1} ${y1}, ${control2} ${y2}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 6,
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function readPalette(): FlowPalette {
  if (typeof document === 'undefined') return { ...COLOR_FALLBACK }
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback
  return {
    accent: read('--accent', COLOR_FALLBACK.accent),
    border: read('--border-default', COLOR_FALLBACK.border),
    surface: read('--bg-raised', COLOR_FALLBACK.surface),
    text: read('--text-primary', COLOR_FALLBACK.text),
    muted: read('--text-tertiary', COLOR_FALLBACK.muted),
    background: read('--bg-base', COLOR_FALLBACK.background),
  }
}

function buildExportSvg(
  nodes: FlowNodeLayout[],
  edges: FlowEdgeDef[],
  exportNode: (id: string) => FlowExportNode | null,
  palette: FlowPalette,
): { svg: string; width: number; height: number } {
  const minX = nodes.length > 0 ? Math.min(...nodes.map((node) => node.x)) : 0
  const minY = nodes.length > 0 ? Math.min(...nodes.map((node) => node.y)) : 0
  const maxX = nodes.length > 0 ? Math.max(...nodes.map((node) => node.x + node.width)) : 0
  const maxY = nodes.length > 0 ? Math.max(...nodes.map((node) => node.y + node.height)) : 0
  const width = Math.max(EXPORT_MIN_WIDTH, Math.ceil(maxX - minX) + EXPORT_PADDING * 2)
  const height = Math.max(EXPORT_MIN_HEIGHT, Math.ceil(maxY - minY) + EXPORT_PADDING * 2)
  const offsetX = -minX + EXPORT_PADDING
  const offsetY = -minY + EXPORT_PADDING
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  const nodeShapes = nodes
    .map((node) => {
      const info = exportNode(node.id)
      if (!info) return ''
      const x = node.x + offsetX
      const y = node.y + offsetY
      const parts: string[] = [
        `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="8" fill="${palette.surface}" stroke="${palette.border}" stroke-width="1"/>`,
        `<line x1="${x}" y1="${y + EXPORT_HEADER_HEIGHT}" x2="${x + node.width}" y2="${y + EXPORT_HEADER_HEIGHT}" stroke="${palette.border}" stroke-width="1"/>`,
        `<text x="${x + 10}" y="${y + EXPORT_HEADER_BASELINE}" font-family="${EXPORT_FONT_FAMILY}" font-size="11" font-weight="600" fill="${palette.text}">${escapeXml(info.title)}</text>`,
      ]
      info.lines.forEach((line, index) => {
        const lineY = y + EXPORT_FIRST_ROW_BASELINE + index * EXPORT_ROW_HEIGHT
        const highlighted = info.highlightLines?.has(index) ?? false
        if (highlighted) {
          parts.push(
            `<rect x="${x + 1}" y="${lineY - EXPORT_ROW_HEIGHT + 4}" width="${node.width - 2}" height="${EXPORT_ROW_HEIGHT}" fill="${palette.accent}" fill-opacity="0.14"/>`,
          )
        }
        parts.push(
          `<text x="${x + 10}" y="${lineY}" font-family="${EXPORT_FONT_FAMILY}" font-size="9.5" fill="${highlighted ? palette.accent : palette.muted}">${escapeXml(line)}</text>`,
        )
      })
      return parts.join('')
    })
    .join('')

  const edgeShapes = edges
    .map((edge) => {
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (!source || !target) return ''
      const geometry = edgeGeometry(
        { ...source, x: source.x + offsetX, y: source.y + offsetY },
        { ...target, x: target.x + offsetX, y: target.y + offsetY },
      )
      const label = edge.label
        ? `<text x="${geometry.labelX}" y="${geometry.labelY}" font-family="${EXPORT_FONT_FAMILY}" font-size="9" fill="${palette.muted}" text-anchor="middle">${escapeXml(edge.label)}</text>`
        : ''
      return `<path d="${geometry.d}" fill="none" stroke="${palette.accent}" stroke-width="1.2" opacity="0.65" marker-end="url(#${ARROW_MARKER_ID})"/>${label}`
    })
    .join('')

  const marker = `<marker id="${ARROW_MARKER_ID}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${palette.accent}"/></marker>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${marker}</defs><rect width="${width}" height="${height}" fill="${palette.background}"/>${edgeShapes}${nodeShapes}</svg>`
  return { svg, width, height }
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('svg image load failed'))
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('png encoding failed'))
    }, 'image/png')
  })
}

function safeFileBase(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'flow'
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  if (typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(url), EXPORT_REVOKE_DELAY_MS)
  }
}

export function SvgFlow({
  nodes,
  edges,
  renderNode,
  nodeLabel,
  selectedId,
  onSelect,
  onNodesChange,
  onNodeContextMenu,
  exportNode,
  exportName = 'flow',
  onError,
  className,
}: SvgFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const fittedSignature = useRef<string | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [internalSelected, setInternalSelected] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const selected = selectedId !== undefined ? selectedId : internalSelected
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const nodeSignature = nodes.map((node) => node.id).join('|')
  const shouldCull = nodes.length > 120

  const visibleRect = useMemo(() => {
    if (!shouldCull || size.width === 0 || size.height === 0) return null
    const margin = 240
    return {
      minX: -viewport.x / viewport.zoom - margin,
      minY: -viewport.y / viewport.zoom - margin,
      maxX: (size.width - viewport.x) / viewport.zoom + margin,
      maxY: (size.height - viewport.y) / viewport.zoom + margin,
    }
  }, [size.height, size.width, viewport])

  const visibleNodes = useMemo(() => {
    if (!visibleRect) return nodes
    return nodes.filter((node) => node.id === selected
      || (node.x + node.width >= visibleRect.minX
        && node.x <= visibleRect.maxX
        && node.y + node.height >= visibleRect.minY
        && node.y <= visibleRect.maxY))
  }, [nodes, selected, visibleRect])

  const visibleEdges = useMemo(() => {
    if (!visibleRect) return edges
    return edges.filter((edge) => {
      const source = nodeById.get(edge.source)
      const target = nodeById.get(edge.target)
      if (!source || !target) return false
      const padding = 160
      return Math.max(source.x + source.width, target.x + target.width) + padding >= visibleRect.minX
        && Math.min(source.x, target.x) - padding <= visibleRect.maxX
        && Math.max(source.y + source.height, target.y + target.height) + padding >= visibleRect.minY
        && Math.min(source.y, target.y) - padding <= visibleRect.maxY
    })
  }, [edges, nodeById, visibleRect])

  const select = useCallback(
    (id: string | null) => {
      if (onSelect) onSelect(id)
      else setInternalSelected(id)
    },
    [onSelect],
  )

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fitView = useCallback(() => {
    if (nodes.length === 0 || size.width === 0 || size.height === 0) return
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    const boxWidth = Math.max(maxX - minX, 1)
    const boxHeight = Math.max(maxY - minY, 1)
    const zoom = clamp(
      Math.min((size.width - FIT_PADDING * 2) / boxWidth, (size.height - FIT_PADDING * 2) / boxHeight),
      FIT_MIN_ZOOM,
      FIT_MAX_ZOOM,
    )
    setViewport({
      zoom,
      x: (size.width - boxWidth * zoom) / 2 - minX * zoom,
      y: (size.height - boxHeight * zoom) / 2 - minY * zoom,
    })
  }, [nodes, size])

  useEffect(() => {
    if (nodes.length === 0 || size.width === 0 || size.height === 0) return
    if (fittedSignature.current === nodeSignature) return
    fittedSignature.current = nodeSignature
    fitView()
  }, [fitView, nodeSignature, nodes.length, size.height, size.width])

  const zoomBy = useCallback((factor: number, centerX?: number, centerY?: number) => {
    setViewport((previous) => {
      const zoom = clamp(previous.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      if (zoom === previous.zoom) return previous
      const rect = containerRef.current?.getBoundingClientRect()
      const pointX = centerX ?? (rect ? rect.width / 2 : 0)
      const pointY = centerY ?? (rect ? rect.height / 2 : 0)
      const worldX = (pointX - previous.x) / previous.zoom
      const worldY = (pointY - previous.y) / previous.zoom
      return { zoom, x: pointX - worldX * zoom, y: pointY - worldY * zoom }
    })
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY === 0) return
      const rect = element.getBoundingClientRect()
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const onBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.button !== 1) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[data-flow-node], button, a, input, textarea, select, [role="menu"]')) return
      dragRef.current = {
        mode: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        origin: viewport,
      }
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      event.currentTarget.focus({ preventScroll: true })
    },
    [viewport],
  )

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      select(id)
      const node = nodeById.get(id)
      if (!node) return
      dragRef.current = {
        mode: 'node',
        startX: event.clientX,
        startY: event.clientY,
        origin: viewport,
        nodeId: id,
        nodeStart: { x: node.x, y: node.y },
      }
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      event.currentTarget.focus({ preventScroll: true })
    },
    [nodeById, select, viewport],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.mode === 'pan') {
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        setViewport({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy })
        return
      }
      if (!drag.nodeId || !drag.nodeStart) return
      const dx = (event.clientX - drag.startX) / drag.origin.zoom
      const dy = (event.clientY - drag.startY) / drag.origin.zoom
      onNodesChange?.(drag.nodeId, drag.nodeStart.x + dx, drag.nodeStart.y + dy)
    },
    [onNodesChange],
  )

  const onPointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  const onNodeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select(id)
        return
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        if (!onNodeContextMenu) return
        event.preventDefault()
        event.stopPropagation()
        select(id)
        const rect = event.currentTarget.getBoundingClientRect()
        onNodeContextMenu(id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        return
      }
      if (!event.key.startsWith('Arrow') || !onNodesChange) return
      const node = nodeById.get(id)
      if (!node) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? NODE_NUDGE_FINE : NODE_NUDGE
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
      if (dx === 0 && dy === 0) return
      select(id)
      onNodesChange(id, node.x + dx, node.y + dy)
    },
    [nodeById, onNodeContextMenu, onNodesChange, select],
  )

  const onNodeContextMenuEvent = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, id: string) => {
      if (!onNodeContextMenu) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      select(id)
      onNodeContextMenu(id, { x: event.clientX, y: event.clientY })
    },
    [onNodeContextMenu, select],
  )

  const onCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(ZOOM_STEP, size.width / 2, size.height / 2)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(1 / ZOOM_STEP, size.width / 2, size.height / 2)
      }
    },
    [size.height, size.width, zoomBy],
  )

  const downloadPng = useCallback(async () => {
    if (!exportNode || exporting) return
    setExporting(true)
    try {
      const palette = readPalette()
      const { svg, width, height } = buildExportSvg(nodes, edges, exportNode, palette)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('2d canvas unavailable')
      const image = await loadSvgImage(svg)
      context.fillStyle = palette.background
      context.fillRect(0, 0, width, height)
      context.drawImage(image, 0, 0)
      const blob = await canvasToBlob(canvas)
      triggerDownload(blob, `${safeFileBase(exportName)}.png`)
    } catch {
      const message = t('development.database.flow.export_failed')
      if (onError) onError(message)
      else useUi.getState().toast({ title: message, tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }, [edges, exportName, exportNode, exporting, nodes, onError])

  const minimap = useMemo(() => {
    if (nodes.length === 0) return null
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    const boxWidth = Math.max(maxX - minX, 1)
    const boxHeight = Math.max(maxY - minY, 1)
    const scale = MINIMAP_WIDTH / boxWidth
    const height = Math.max(MINIMAP_MIN_HEIGHT, Math.round(boxHeight * scale))
    const viewRect = {
      x: (-viewport.x / viewport.zoom - minX) * scale,
      y: (-viewport.y / viewport.zoom - minY) * scale,
      width: (size.width / viewport.zoom) * scale,
      height: (size.height / viewport.zoom) * scale,
    }
    return { width: MINIMAP_WIDTH, height, scale, minX, minY, viewRect }
  }, [nodes, size.height, size.width, viewport])

  return (
    <div
      ref={containerRef}
      data-flow-canvas="true"
      data-flow-zoom={viewport.zoom}
      role="region"
      aria-label={t('development.database.flow.canvas')}
      tabIndex={0}
      className={cn(
        'relative h-full w-full touch-none select-none overflow-hidden bg-[var(--bg-sunken)] outline-none',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
        className,
      )}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onCanvasKeyDown}
    >
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
        <defs>
          <marker
            id={ARROW_MARKER_ID}
            markerWidth={8}
            markerHeight={8}
            refX={7}
            refY={4}
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
          </marker>
        </defs>
        <g transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.zoom})`}>
          {visibleEdges.map((edge) => {
            const source = nodeById.get(edge.source)
            const target = nodeById.get(edge.target)
            if (!source || !target) return null
            const geometry = edgeGeometry(source, target)
            return (
              <g key={edge.id} data-flow-edge={edge.id}>
                <path
                  d={geometry.d}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.2}
                  strokeOpacity={0.65}
                  markerEnd={`url(#${ARROW_MARKER_ID})`}
                />
                {edge.label && (
                  <text
                    x={geometry.labelX}
                    y={geometry.labelY}
                    fontSize={9}
                    fontFamily={EXPORT_FONT_FAMILY}
                    fill="var(--text-tertiary)"
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      <div
        data-flow-node-layer="true"
        className="absolute top-0 left-0"
        style={{
          transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {visibleNodes.map((node) => {
          const isSelected = selected === node.id
          return (
            <div
              key={node.id}
              data-flow-node={node.id}
              role="group"
              tabIndex={0}
              aria-label={nodeLabel ? nodeLabel(node.id) : node.id}
              aria-current={isSelected ? 'true' : undefined}
              className={cn(
                'absolute touch-none rounded-[var(--r-lg)] outline-none',
                'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-sunken)]',
                isSelected && 'ring-2 ring-[var(--accent)]',
              )}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onPointerDown={(event) => onNodePointerDown(event, node.id)}
              onFocus={() => select(node.id)}
              onKeyDown={(event) => onNodeKeyDown(event, node.id)}
              onContextMenu={(event) => onNodeContextMenuEvent(event, node.id)}
            >
              {renderNode(node.id)}
            </div>
          )
        })}
      </div>

      <div
        data-flow-controls="true"
        className="absolute right-3 bottom-3 flex flex-col gap-1"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Tooltip label={t('development.database.flow.zoom_in')} side="left">
          <IconButton
            label={t('development.database.flow.zoom_in')}
            size="md"
            variant="secondary"
            className="bg-[var(--bg-overlay)] shadow-[var(--shadow-sm)]"
            onClick={() => zoomBy(ZOOM_STEP, size.width / 2, size.height / 2)}
          >
            <Plus size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('development.database.flow.zoom_out')} side="left">
          <IconButton
            label={t('development.database.flow.zoom_out')}
            size="md"
            variant="secondary"
            className="bg-[var(--bg-overlay)] shadow-[var(--shadow-sm)]"
            onClick={() => zoomBy(1 / ZOOM_STEP, size.width / 2, size.height / 2)}
          >
            <Minus size={14} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('development.database.flow.fit_view')} side="left">
          <IconButton
            label={t('development.database.flow.fit_view')}
            size="md"
            variant="secondary"
            className="bg-[var(--bg-overlay)] shadow-[var(--shadow-sm)]"
            onClick={fitView}
          >
            <Maximize2 size={14} />
          </IconButton>
        </Tooltip>
        {exportNode && (
          <Tooltip label={t('development.database.flow.export_png')} side="left">
            <IconButton
              label={t('development.database.flow.export_png')}
              size="md"
              variant="secondary"
              className="bg-[var(--bg-overlay)] shadow-[var(--shadow-sm)]"
              onClick={() => void downloadPng()}
              disabled={exporting}
            >
              {exporting ? <Spinner size={13} /> : <Download size={14} />}
            </IconButton>
          </Tooltip>
        )}
      </div>

      {minimap && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3 left-3 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-sm)]"
        >
          <svg width={minimap.width} height={minimap.height} className="block">
            <rect width={minimap.width} height={minimap.height} fill="var(--bg-inset)" />
            {nodes.map((node) => (
              <rect
                key={node.id}
                x={(node.x - minimap.minX) * minimap.scale}
                y={(node.y - minimap.minY) * minimap.scale}
                width={Math.max(MINIMAP_MIN_NODE_PX, node.width * minimap.scale)}
                height={Math.max(MINIMAP_MIN_NODE_PX, node.height * minimap.scale)}
                rx={1.5}
                fill="var(--accent)"
                opacity={0.55}
              />
            ))}
            <rect
              x={minimap.viewRect.x}
              y={minimap.viewRect.y}
              width={minimap.viewRect.width}
              height={minimap.viewRect.height}
              fill="none"
              stroke="var(--text-secondary)"
              strokeWidth={1}
              strokeDasharray="3 2"
              opacity={0.6}
            />
          </svg>
        </div>
      )}
    </div>
  )
}
