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
import { downloadFlowPng, edgeGeometry, FLOW_FONT_FAMILY, type FlowExportNode } from './flow-export'

export type { FlowEdgeDef, FlowNodeLayout } from './flow-layout'
export type { FlowExportNode } from './flow-export'

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
  selectionMode?: 'pan' | 'marquee'
  selectedIds?: ReadonlySet<string>
  onSelectionChange?: (ids: Set<string>) => void
  selectedEdgeId?: string | null
  onEdgeSelect?: (edgeId: string | null) => void
  onDeleteSelection?: () => void
  snapGrid?: number
  viewport?: Viewport
  onViewportChange?: (viewport: Viewport) => void
  renderOverlay?: (viewport: Viewport) => ReactNode
  onNodeDoubleClick?: (id: string) => void
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

interface MarqueeState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  moved: boolean
}

interface DragState {
  mode: 'pan' | 'node'
  startX: number
  startY: number
  origin: Viewport
  nodeId?: string
  nodeStart?: { x: number; y: number }
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
const ARROW_MARKER_ID = 'arrow'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
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
  selectionMode = 'pan',
  selectedIds,
  onSelectionChange,
  selectedEdgeId,
  onEdgeSelect,
  onDeleteSelection,
  snapGrid,
  viewport: controlledViewport,
  onViewportChange,
  renderOverlay,
  onNodeDoubleClick,
}: SvgFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const pointerFocus = useRef(false)
  const fittedSignature = useRef<string | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [internalViewport, setInternalViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [internalSelected, setInternalSelected] = useState<string | null>(null)
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(() => new Set())
  const [internalEdge, setInternalEdge] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [exporting, setExporting] = useState(false)

  const viewport = controlledViewport ?? internalViewport
  const selected = selectedId !== undefined ? selectedId : internalSelected
  const activeEdge = selectedEdgeId !== undefined ? selectedEdgeId : internalEdge
  const selection = useMemo(() => {
    if (selectedIds) return selectedIds
    if (internalSelectedIds.size > 0) return internalSelectedIds
    return selected ? new Set([selected]) : new Set<string>()
  }, [internalSelectedIds, selected, selectedIds])
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const nodeSignature = nodes.map((node) => node.id).join('|')
  const shouldCull = nodes.length > 120

  const updateViewport = useCallback((next: Viewport) => {
    if (onViewportChange) onViewportChange(next)
    else setInternalViewport(next)
  }, [onViewportChange])

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
      if (onSelectionChange) onSelectionChange(id ? new Set([id]) : new Set())
      else if (onSelect) onSelect(id)
      else setInternalSelected(id)
      if (onEdgeSelect) onEdgeSelect(null)
      else setInternalEdge(null)
    },
    [onEdgeSelect, onSelect, onSelectionChange],
  )

  const applySelection = useCallback(
    (ids: Set<string>) => {
      if (onSelectionChange) onSelectionChange(ids)
      else setInternalSelectedIds(ids)
      if (!onSelectionChange && onSelect) onSelect(ids.size === 1 ? [...ids][0] ?? null : null)
    },
    [onSelect, onSelectionChange],
  )

  const selectEdge = useCallback(
    (id: string | null) => {
      if (onEdgeSelect) onEdgeSelect(id)
      else setInternalEdge(id)
    },
    [onEdgeSelect],
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
    updateViewport({
      zoom,
      x: (size.width - boxWidth * zoom) / 2 - minX * zoom,
      y: (size.height - boxHeight * zoom) / 2 - minY * zoom,
    })
  }, [nodes, size, updateViewport])

  useEffect(() => {
    if (nodes.length === 0 || size.width === 0 || size.height === 0) return
    if (fittedSignature.current === nodeSignature) return
    fittedSignature.current = nodeSignature
    fitView()
  }, [fitView, nodeSignature, nodes.length, size.height, size.width])

  const zoomBy = useCallback((factor: number, centerX?: number, centerY?: number) => {
    const zoom = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM)
    if (zoom === viewport.zoom) return
    const rect = containerRef.current?.getBoundingClientRect()
    const pointX = centerX ?? (rect ? rect.width / 2 : 0)
    const pointY = centerY ?? (rect ? rect.height / 2 : 0)
    const worldX = (pointX - viewport.x) / viewport.zoom
    const worldY = (pointY - viewport.y) / viewport.zoom
    updateViewport({ zoom, x: pointX - worldX * zoom, y: pointY - worldY * zoom })
  }, [updateViewport, viewport])

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
      selectEdge(null)
      if (selectionMode === 'marquee' && event.button === 0) {
        const rect = event.currentTarget.getBoundingClientRect()
        const startX = event.clientX - rect.left
        const startY = event.clientY - rect.top
        setMarquee({
          startX,
          startY,
          currentX: startX,
          currentY: startY,
          additive: event.ctrlKey || event.metaKey,
          moved: false,
        })
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        event.currentTarget.focus({ preventScroll: true })
        return
      }
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
    [selectEdge, selectionMode, viewport],
  )

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      const additive = event.ctrlKey || event.metaKey
      if (additive && (onSelectionChange || selectedIds)) {
        const next = new Set(selection)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        applySelection(next)
      } else if (!selection.has(id) || selection.size > 1) {
        select(id)
      } else {
        selectEdge(null)
      }
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
      pointerFocus.current = true
      event.currentTarget.focus({ preventScroll: true })
      pointerFocus.current = false
    },
    [applySelection, nodeById, onSelectionChange, select, selectEdge, selectedIds, selection, viewport],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (marquee) {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const currentX = event.clientX - rect.left
        const currentY = event.clientY - rect.top
        setMarquee({
          ...marquee,
          currentX,
          currentY,
          moved: marquee.moved || Math.abs(currentX - marquee.startX) > 3 || Math.abs(currentY - marquee.startY) > 3,
        })
        return
      }
      const drag = dragRef.current
      if (!drag) return
      if (drag.mode === 'pan') {
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        updateViewport({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy })
        return
      }
      if (!drag.nodeId || !drag.nodeStart) return
      const dx = (event.clientX - drag.startX) / drag.origin.zoom
      const dy = (event.clientY - drag.startY) / drag.origin.zoom
      let nextX = drag.nodeStart.x + dx
      let nextY = drag.nodeStart.y + dy
      if (snapGrid && snapGrid > 0) {
        nextX = Math.round(nextX / snapGrid) * snapGrid
        nextY = Math.round(nextY / snapGrid) * snapGrid
      }
      onNodesChange?.(drag.nodeId, nextX, nextY)
    },
    [marquee, onNodesChange, snapGrid, updateViewport],
  )

  const onPointerUp = useCallback(() => {
    if (marquee) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const left = Math.min(marquee.startX, marquee.currentX)
        const top = Math.min(marquee.startY, marquee.currentY)
        const right = Math.max(marquee.startX, marquee.currentX)
        const bottom = Math.max(marquee.startY, marquee.currentY)
        const worldLeft = (left - viewport.x) / viewport.zoom
        const worldTop = (top - viewport.y) / viewport.zoom
        const worldRight = (right - viewport.x) / viewport.zoom
        const worldBottom = (bottom - viewport.y) / viewport.zoom
        const hits = new Set<string>()
        if (marquee.moved) {
          for (const node of nodes) {
            const intersects = node.x + node.width >= worldLeft
              && node.x <= worldRight
              && node.y + node.height >= worldTop
              && node.y <= worldBottom
            if (intersects) hits.add(node.id)
          }
        }
        const next = marquee.additive ? new Set([...selection, ...hits]) : hits
        applySelection(next)
        if (next.size === 0) selectEdge(null)
      }
      setMarquee(null)
    }
    dragRef.current = null
  }, [applySelection, marquee, nodes, selectEdge, selection, viewport])

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
      const target = event.target instanceof Element ? event.target : null
      const editing = target?.closest('input, textarea, select, [contenteditable="true"]')
      if (!editing && onDeleteSelection && (selection.size > 0 || activeEdge)) {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          onDeleteSelection()
          return
        }
      }
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
    [activeEdge, onDeleteSelection, selection, size.height, size.width, zoomBy],
  )

  const downloadPng = useCallback(async () => {
    if (!exportNode || exporting) return
    setExporting(true)
    try {
      await downloadFlowPng(nodes, edges, exportNode, exportName)
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
            const isSelectedEdge = activeEdge === edge.id
            const interactive = Boolean(onEdgeSelect)
            return (
              <g key={edge.id} data-flow-edge={edge.id} data-flow-edge-selected={isSelectedEdge ? 'true' : undefined}>
                {interactive && (
                  <path
                    d={geometry.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      selectEdge(edge.id)
                    }}
                  />
                )}
                <path
                  d={geometry.d}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={isSelectedEdge ? 2.2 : 1.2}
                  strokeOpacity={isSelectedEdge ? 1 : 0.65}
                  markerEnd={`url(#${ARROW_MARKER_ID})`}
                  style={interactive ? { pointerEvents: 'stroke', cursor: 'pointer' } : undefined}
                />
                {edge.label && (
                  <text
                    x={geometry.labelX}
                    y={geometry.labelY}
                    fontSize={9}
                    fontFamily={FLOW_FONT_FAMILY}
                    fill="var(--text-tertiary)"
                    textAnchor="middle"
                    style={{ pointerEvents: 'none' }}
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {renderOverlay && (
        <div className="pointer-events-none absolute inset-0" data-flow-overlay="true">
          {renderOverlay(viewport)}
        </div>
      )}

      <div
        data-flow-node-layer="true"
        className="absolute top-0 left-0"
        style={{
          transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {visibleNodes.map((node) => {
          const isSelected = selection.has(node.id)
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
              onDoubleClick={() => onNodeDoubleClick?.(node.id)}
              onFocus={() => { if (!pointerFocus.current) select(node.id) }}
              onKeyDown={(event) => onNodeKeyDown(event, node.id)}
              onContextMenu={(event) => onNodeContextMenuEvent(event, node.id)}
            >
              {renderNode(node.id)}
            </div>
          )
        })}
      </div>

      {marquee && marquee.moved && (
        <div
          data-flow-marquee="true"
          aria-hidden="true"
          className="pointer-events-none absolute z-10 border border-[var(--accent)] bg-[var(--accent-soft)] opacity-70"
          style={{
            left: Math.min(marquee.startX, marquee.currentX),
            top: Math.min(marquee.startY, marquee.currentY),
            width: Math.abs(marquee.currentX - marquee.startX),
            height: Math.abs(marquee.currentY - marquee.startY),
          }}
        />
      )}

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
