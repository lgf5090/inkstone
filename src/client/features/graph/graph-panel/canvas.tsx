import { useCallback, useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import type { GraphResponse } from '@shared/types'
import { t } from '../../../lib/i18n'
import type { GraphPreferences } from '../../../lib/graph-settings'
import {
  GRAPH_DPR_MAX,
  GRAPH_DRAG_RESUME_FRAMES,
  GRAPH_FIT_MAX_SCALE,
  GRAPH_MAX_SCALE,
  GRAPH_MIN_SCALE,
  GRAPH_POINTER_SUPPRESS_MS,
  GRAPH_ZOOM_STEP,
  PHYSICS_FRAME_LIMIT,
} from './constants'
import { drawScene } from './draw'
import {
  buildSceneEdges,
  buildSceneNodes,
  dragMovedEnough,
  fitBounds,
  graphScaleAfterWheel,
  neighbourIds,
  nodeAtPoint,
  nodeRadius,
  pickDirectional,
  prefersReducedMotion,
  readPalette,
  resumeScene,
  settleScene,
  settledInTime,
  stampColorGroups,
  stepPhysics,
} from './scene'
import type { CanvasNode, CanvasState, GraphCanvasCallbacks, GraphCanvasControls } from './types'

function emptyState(): CanvasState {
  return {
    nodes: [], edges: [], scale: 1, offsetX: 0, offsetY: 0,
    dragging: null, pointers: new Map(), pinch: null,
    frame: 0, raf: 0, needsFit: false, initialized: false, palette: readPalette(),
    emphasis: { id: null, neighbours: new Set<string>() }, searchHits: null, schedule: null,
  }
}

export function createGraphState(): CanvasState {
  return emptyState()
}

export interface GraphCanvasProps {
  data: GraphResponse
  prefs: GraphPreferences
  activeNoteId: string | null
  searchHits: ReadonlySet<string> | null
  pinnedIds: readonly string[]
  callbacks: GraphCanvasCallbacks
  stateRef: RefObject<CanvasState>
  controlsRef: RefObject<GraphCanvasControls | null>
  onHoverChange?: (node: CanvasNode | null, x?: number, y?: number) => void
  onSelectChange?: (id: string | null) => void
  onContextNode?: (node: CanvasNode, x: number, y: number) => void
  onPaintError?: (error: unknown) => void
}

export function GraphCanvas({
  data, prefs, activeNoteId, searchHits, pinnedIds, callbacks,
  stateRef, controlsRef, onHoverChange, onSelectChange, onContextNode, onPaintError,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hoverRef = useRef<CanvasNode | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const activeNoteIdRef = useRef<string | null>(activeNoteId)
  const lastPointerEventAtRef = useRef(Number.NEGATIVE_INFINITY)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const hoverReportRef = useRef(onHoverChange)
  hoverReportRef.current = onHoverChange
  const selectReportRef = useRef(onSelectChange)
  selectReportRef.current = onSelectChange
  const contextReportRef = useRef(onContextNode)
  contextReportRef.current = onContextNode
  const paintErrorRef = useRef(onPaintError)
  paintErrorRef.current = onPaintError

  const setSelected = useCallback((id: string | null) => {    if (selectedIdRef.current === id) return
    selectedIdRef.current = id
    selectReportRef.current?.(id)
    stateRef.current.schedule?.()
  }, [])

  const fitGraph = useCallback(() => {
    const canvas = canvasRef.current
    const current = stateRef.current
    if (!canvas || !current.nodes.length) return
    const rect = canvas.getBoundingClientRect()
    const hits = current.searchHits
    const focused = hits ? current.nodes.filter((node) => hits.has(node.id)) : []
    const scope = focused.length ? focused : current.nodes
    const next = fitBounds(scope, rect.width, rect.height, GRAPH_FIT_MAX_SCALE, GRAPH_MIN_SCALE)
    if (!next) return
    current.scale = next.scale
    current.offsetX = next.offsetX
    current.offsetY = next.offsetY
    current.schedule?.()
  }, [])

  const centerOn = useCallback((node: CanvasNode) => {
    const canvas = canvasRef.current
    const current = stateRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    current.offsetX = rect.width / 2 - node.x * current.scale
    current.offsetY = rect.height / 2 - node.y * current.scale
    current.schedule?.()
  }, [])

  const zoomAt = useCallback((next: number, clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const current = stateRef.current
    if (!canvas || next === current.scale) return
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    current.offsetX = x - (x - current.offsetX) / current.scale * next
    current.offsetY = y - (y - current.offsetY) / current.scale * next
    current.scale = next
    current.schedule?.()
  }, [])

  const zoomFromCenter = useCallback((next: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [zoomAt])

  useImperativeHandle(controlsRef, () => ({
    zoomIn: () => zoomFromCenter(Math.min(GRAPH_MAX_SCALE, stateRef.current.scale + GRAPH_ZOOM_STEP)),
    zoomOut: () => zoomFromCenter(Math.max(GRAPH_MIN_SCALE, stateRef.current.scale - GRAPH_ZOOM_STEP)),
    fit: fitGraph,
    selectNode: (id: string) => {
      const node = stateRef.current.nodes.find((item) => item.id === id)
      if (!node) return
      setSelected(id)
      centerOn(node)
    },
    centerOn: (id: string) => {
      const node = stateRef.current.nodes.find((item) => item.id === id)
      if (node) centerOn(node)
    },
    scale: () => stateRef.current.scale,
  }), [centerOn, fitGraph, setSelected, zoomFromCenter])

  useEffect(() => {
    const current = stateRef.current
    const carried = new Map(current.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
    hoverRef.current = null
    hoverReportRef.current?.(null)
    if (selectedIdRef.current && !data.nodes.some((node) => node.id === selectedIdRef.current)) {
      selectedIdRef.current = null
      selectReportRef.current?.(null)
    }
    current.nodes = buildSceneNodes(data, prefsRef.current, carried, [])
    current.edges = buildSceneEdges(data, current.nodes)
    current.needsFit = true
    current.frame = 0
    if (prefersReducedMotion()) settleScene(current, prefsRef.current)
  }, [data, stateRef])

  useEffect(() => {
    const current = stateRef.current
    for (const node of current.nodes) node.r = nodeRadius(node, prefs.nodeScale)
    current.schedule?.()
  }, [prefs.nodeScale, data, stateRef])

  useEffect(() => {
    const current = stateRef.current
    const pinned = new Set(pinnedIds)
    for (const node of current.nodes) node.pinned = pinned.has(node.id)
    current.schedule?.()
  }, [pinnedIds, stateRef])

  useEffect(() => {
    const current = stateRef.current
    stampColorGroups(current.nodes, prefs.colorGroups)
    current.schedule?.()
  }, [prefs.colorGroups, prefs.groupBy, data, stateRef])

  useEffect(() => {
    stateRef.current.searchHits = searchHits
    stateRef.current.schedule?.()
  }, [searchHits, stateRef])

  useEffect(() => {
    resumeScene(stateRef.current)
    stateRef.current.needsFit = true
    stateRef.current.schedule?.()
  }, [prefs.linkDistance, prefs.repulsion, stateRef])

  useEffect(() => {
    stateRef.current.schedule?.()
  }, [prefs.arrows, prefs.labels, prefs.groupBy, activeNoteId, stateRef])

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId
    stateRef.current.schedule?.()
  }, [activeNoteId, stateRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const current = stateRef.current
    const resize = () => {
      const dpr = Math.min(GRAPH_DPR_MAX, devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!current.initialized) {
        current.initialized = true
        current.offsetX = rect.width / 2
        current.offsetY = rect.height / 2
      }
      current.schedule?.()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const schedule = () => { if (!current.raf) current.raf = requestAnimationFrame(tick) }
    const paintFrame = () => {
      const rect = canvas.getBoundingClientRect()
      if (current.frame < PHYSICS_FRAME_LIMIT) {
        current.frame++
        const movement = stepPhysicsFrame(current)
        if (settledInTime(current.frame, movement, current.nodes.length)) current.frame = PHYSICS_FRAME_LIMIT
      }
      if (current.needsFit && current.frame >= PHYSICS_FRAME_LIMIT) {
        current.needsFit = false
        fitGraph()
      }
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.save()
      ctx.translate(current.offsetX, current.offsetY)
      ctx.scale(current.scale, current.scale)
      const emphasizedId = hoverRef.current?.id ?? selectedIdRef.current ?? null
      if (current.emphasis.id !== emphasizedId) {
        current.emphasis = emphasizedId
          ? { id: emphasizedId, neighbours: neighbourIds(current.edges, emphasizedId) }
          : { id: null, neighbours: new Set<string>() }
      }
      const active = prefsRef.current
      drawScene({
        ctx,
        state: current,
        colors: current.palette,
        groupBy: active.groupBy,
        arrows: active.arrows,
        labels: active.labels,
        emphasizedId,
        neighborIds: current.emphasis.neighbours,
        activeNoteId: activeNoteIdRef.current,
        selectedId: selectedIdRef.current,
        scale: current.scale,
      })
      ctx.restore()
    }
    const tick = () => {
      current.raf = 0
      try {
        paintFrame()
      } catch (error) {
        paintErrorRef.current?.(error)
        return
      }
      if (current.frame < PHYSICS_FRAME_LIMIT) schedule()
    }
    current.schedule = schedule
    schedule()
    const themeObserver = new MutationObserver(() => {
      current.palette = readPalette()
      schedule()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-background'],
    })
    return () => {
      cancelAnimationFrame(current.raf)
      current.raf = 0
      current.schedule = null
      current.pointers.clear()
      current.dragging = null
      current.pinch = null
      themeObserver.disconnect()
      observer.disconnect()
    }
  }, [fitGraph, stateRef])

  const stepPhysicsFrame = (current: CanvasState) => {
    const active = prefsRef.current
    return stepPhysics(current.nodes, current.edges, active.repulsion, active.linkDistance, current.dragging?.node ?? null)
  }

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const current = stateRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (clientX - rect.left - current.offsetX) / current.scale,
      y: (clientY - rect.top - current.offsetY) / current.scale,
    }
  }, [])

  const nodeAt = useCallback((clientX: number, clientY: number): CanvasNode | null => {
    const current = stateRef.current
    const point = toWorld(clientX, clientY)
    return nodeAtPoint(current.nodes, point.x, point.y, current.scale)
  }, [toWorld])

  const beginDrag = useCallback((clientX: number, clientY: number, button: number) => {
    if (button !== 0) return
    const current = stateRef.current
    const point = toWorld(clientX, clientY)
    const node = nodeAtPoint(current.nodes, point.x, point.y, current.scale)
    current.dragging = { node, startX: clientX, startY: clientY, ox: current.offsetX, oy: current.offsetY }
    if (node) setSelected(node.id)
  }, [setSelected, toWorld])

  const toScreen = useCallback((node: CanvasNode | null): [number, number] => {
    const canvas = canvasRef.current
    const current = stateRef.current
    if (!canvas || !node) return [0, 0]
    const rect = canvas.getBoundingClientRect()
    return [rect.left + current.offsetX + node.x * current.scale, rect.top + current.offsetY + node.y * current.scale]
  }, [])

  const moveDrag = useCallback((clientX: number, clientY: number) => {
    const current = stateRef.current
    const point = toWorld(clientX, clientY)
    if (current.dragging) {
      if (current.dragging.node) {
        current.dragging.node.x = point.x
        current.dragging.node.y = point.y
        current.dragging.node.vx = 0
        current.dragging.node.vy = 0
        resumeScene(current, GRAPH_DRAG_RESUME_FRAMES)
      } else {
        current.offsetX = current.dragging.ox + clientX - current.dragging.startX
        current.offsetY = current.dragging.oy + clientY - current.dragging.startY
      }
      current.schedule?.()
      return
    }
    const node = nodeAtPoint(current.nodes, point.x, point.y, current.scale)
    if (hoverRef.current?.id !== node?.id) {
      hoverRef.current = node
      hoverReportRef.current?.(node, ...toScreen(node))
      current.schedule?.()
    }
  }, [toScreen, toWorld])

  const endDrag = useCallback((clientX: number, clientY: number) => {
    const current = stateRef.current
    const drag = current.dragging
    current.dragging = null
    if (!drag || !drag.node) return
    if (!dragMovedEnough(clientX, clientY, drag)) return
    if (drag.node.pinned) return
    drag.node.pinned = true
    if (prefsRef.current.pinnedNodeIds.includes(drag.node.id)) return
    callbacksRef.current.onPinChange?.(drag.node.id)
    current.schedule?.()
  }, [])

  const releasePointer = useCallback((pointerId: number) => {
    const current = stateRef.current
    current.pointers.delete(pointerId)
    current.dragging = null
    current.pinch = null
    current.schedule?.()
  }, [])

  const openNode = useCallback((node: CanvasNode) => {
    if (node.kind === 'unresolved') callbacksRef.current.onCreateNote(node.title)
    else callbacksRef.current.onOpenNote(node.id)
  }, [])

  const contextNode = useCallback((clientX: number, clientY: number) => {
    const node = nodeAt(clientX, clientY)
    if (node) contextReportRef.current?.(node, clientX, clientY)
    return node
  }, [nodeAt])

  const suppressMouse = () => performance.now() - lastPointerEventAtRef.current <= GRAPH_POINTER_SUPPRESS_MS

  return <canvas
    ref={canvasRef}
    tabIndex={0}
    role="application"
    aria-label={t('graph.graph_canvas_accessible')}
    className="size-full touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] active:cursor-grabbing"
    onPointerDown={(event) => {
      if (event.button !== 0) return
      lastPointerEventAtRef.current = performance.now()
      event.currentTarget.setPointerCapture(event.pointerId)
      const current = stateRef.current
      current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (current.pointers.size === 1) beginDrag(event.clientX, event.clientY, event.button)
      else if (current.pointers.size === 2) {
        const [a, b] = [...current.pointers.values()]
        current.dragging = null
        current.pinch = {
          distance: Math.hypot(b!.x - a!.x, b!.y - a!.y),
          scale: current.scale,
          centerX: (a!.x + b!.x) / 2,
          centerY: (a!.y + b!.y) / 2,
        }
      }
    }}
    onPointerMove={(event) => {
      lastPointerEventAtRef.current = performance.now()
      const current = stateRef.current
      if (current.pointers.has(event.pointerId)) {
        current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }
      if (current.pointers.size >= 2 && current.pinch) {
        const [a, b] = [...current.pointers.values()]
        const distance = Math.hypot(b!.x - a!.x, b!.y - a!.y)
        const next = Math.min(GRAPH_MAX_SCALE, Math.max(GRAPH_MIN_SCALE, current.pinch.scale * distance / Math.max(1, current.pinch.distance)))
        zoomAt(next, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2)
        return
      }
      moveDrag(event.clientX, event.clientY)
    }}
    onPointerUp={(event) => {
      lastPointerEventAtRef.current = performance.now()
      if (event.button !== 0) return
      const current = stateRef.current
      const wasPinching = current.pointers.size >= 2
      current.pointers.delete(event.pointerId)
      if (current.pointers.size < 2) current.pinch = null
      if (wasPinching) {
        current.dragging = null
        const remaining = [...current.pointers.values()][0]
        if (remaining) beginDrag(remaining.x, remaining.y, 0)
      } else {
        endDrag(event.clientX, event.clientY)
      }
    }}
    onPointerCancel={(event) => releasePointer(event.pointerId)}
    onLostPointerCapture={(event) => releasePointer(event.pointerId)}
    onDoubleClick={(event) => {
      const node = nodeAt(event.clientX, event.clientY)
      if (node) openNode(node)
    }}
    onMouseDown={(event) => { if (!suppressMouse()) beginDrag(event.clientX, event.clientY, event.button) }}
    onMouseMove={(event) => { if (!suppressMouse()) moveDrag(event.clientX, event.clientY) }}
    onMouseUp={(event) => { if (!suppressMouse()) endDrag(event.clientX, event.clientY) }}
    onMouseLeave={() => {
      stateRef.current.dragging = null
      hoverRef.current = null
      hoverReportRef.current?.(null)
      stateRef.current.schedule?.()
    }}
    onContextMenu={(event) => {
      event.preventDefault()
      const node = contextNode(event.clientX, event.clientY)
      if (node) setSelected(node.id)
    }}
    onWheel={(event) => {
      const current = stateRef.current
      const next = graphScaleAfterWheel(current.scale, event.deltaY)
      if (next === current.scale) return
      event.preventDefault()
      zoomAt(next, event.clientX, event.clientY)
    }}
    onKeyDown={(event) => {
      const current = stateRef.current
      if (event.key === '+' || event.key === '=') zoomFromCenter(Math.min(GRAPH_MAX_SCALE, current.scale + GRAPH_ZOOM_STEP))
      else if (event.key === '-') zoomFromCenter(Math.max(GRAPH_MIN_SCALE, current.scale - GRAPH_ZOOM_STEP))
      else if (event.key === 'Home') fitGraph()
      else if (event.key === 'Enter' && selectedIdRef.current) {
        const node = current.nodes.find((item) => item.id === selectedIdRef.current)
        if (node) openNode(node)
      }
      else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        const node = current.nodes.find((item) => item.id === selectedIdRef.current)
        if (node) {
          const rect = event.currentTarget.getBoundingClientRect()
          contextReportRef.current?.(
            node,
            rect.left + current.offsetX + node.x * current.scale,
            rect.top + current.offsetY + node.y * current.scale,
          )
        }
      }
      else if (event.key.startsWith('Arrow')) {
        const current2 = stateRef.current
        const from = current2.nodes.find((item) => item.id === selectedIdRef.current) ?? current2.nodes[0]
        const next = from ? pickDirectional(current2.nodes, from, event.key) : null
        if (next) { setSelected(next.id); centerOn(next) }
      } else return
      event.preventDefault()
      current.schedule?.()
    }}/>
}
