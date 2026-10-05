import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownToLine,
  ArrowRight,
  CircleDot,
  Filter,
  FolderOpen,
  Maximize2,
  Minus,
  Network,
  PanelRightClose,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import type { GraphNode, GraphQuery, GraphResponse } from '@shared/types'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { truncateText } from '@shared/text-utils'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Menu, Tooltip, useDialogFocus, useEscape, useLockScroll, type MenuItem } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

const PHYSICS_FRAME_LIMIT = 180
const SPATIAL_CELL_SIZE = 350
const MAX_REPULSION_DIST_SQ = 120000
const GRAPH_PREFS_KEY = 'inkstone.graph.preferences.v1'

type GroupBy = 'none' | 'folder' | 'tag'
interface GraphPreferences {
  mode: 'global' | 'local'
  depth: number
  includeOrphans: boolean
  includeUnresolved: boolean
  arrows: boolean
  labels: boolean
  groupBy: GroupBy
  folderId: string
  tag: string
  repulsion: number
  linkDistance: number
  nodeScale: number
}

const DEFAULT_PREFERENCES: GraphPreferences = {
  mode: 'global',
  depth: 1,
  includeOrphans: true,
  includeUnresolved: true,
  arrows: true,
  labels: true,
  groupBy: 'none',
  folderId: '',
  tag: '',
  repulsion: 900,
  linkDistance: 76,
  nodeScale: 1,
}

export interface CanvasNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  pinned?: boolean
}

interface CanvasState {
  nodes: CanvasNode[]
  edges: Array<{ a: CanvasNode; b: CanvasNode }>
  scale: number
  offsetX: number
  offsetY: number
  dragging: { node: CanvasNode | null; startX: number; startY: number; ox: number; oy: number } | null
  pointers: Map<number, { x: number; y: number }>
  pinch: { distance: number; scale: number; centerX: number; centerY: number } | null
  frame: number
  raf: number
  needsFit: boolean
  palette: Palette
  emphasis: { id: string | null; neighbours: Set<string> }
  schedule: (() => void) | null
}

interface Palette {
  edge: string
  edgeDim: string
  node: string
  accent: string
  label: string
  font: string
}

const FALLBACK_PALETTE: Palette = {
  edge: '#6b7280',
  edgeDim: '#9ca3af',
  node: '#777777',
  accent: '#4f46e5',
  label: '#555555',
  font: 'sans-serif',
}

function readPalette(): Palette {
  if (typeof document === 'undefined') return FALLBACK_PALETTE
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    edge: token('--graph-edge', FALLBACK_PALETTE.edge),
    edgeDim: token('--graph-edge-dim', FALLBACK_PALETTE.edgeDim),
    node: token('--graph-node', FALLBACK_PALETTE.node),
    accent: token('--accent', FALLBACK_PALETTE.accent),
    label: token('--graph-label', FALLBACK_PALETTE.label),
    font: token('--font-ui', FALLBACK_PALETTE.font),
  }
}

export function graphScaleAfterWheel(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return scale
  return Math.min(4, Math.max(0.2, scale * (deltaY > 0 ? 0.92 : 1.08)))
}

function loadPreferences(): GraphPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES
  try {
    const stored = JSON.parse(localStorage.getItem(GRAPH_PREFS_KEY) ?? '{}') as Partial<GraphPreferences>
    return {
      mode: stored.mode === 'local' ? 'local' : 'global',
      depth: boundedPreference(stored.depth, DEFAULT_PREFERENCES.depth, 1, 3),
      includeOrphans: booleanPreference(stored.includeOrphans, DEFAULT_PREFERENCES.includeOrphans),
      includeUnresolved: booleanPreference(stored.includeUnresolved, DEFAULT_PREFERENCES.includeUnresolved),
      arrows: booleanPreference(stored.arrows, DEFAULT_PREFERENCES.arrows),
      labels: booleanPreference(stored.labels, DEFAULT_PREFERENCES.labels),
      groupBy: stored.groupBy === 'folder' || stored.groupBy === 'tag' ? stored.groupBy : 'none',
      folderId: typeof stored.folderId === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(stored.folderId)
        ? stored.folderId
        : '',
      tag: typeof stored.tag === 'string' ? truncateText(stored.tag.trim(), 60) : '',
      repulsion: boundedPreference(stored.repulsion, DEFAULT_PREFERENCES.repulsion, 300, 1800),
      linkDistance: boundedPreference(stored.linkDistance, DEFAULT_PREFERENCES.linkDistance, 40, 150),
      nodeScale: boundedPreference(stored.nodeScale, DEFAULT_PREFERENCES.nodeScale, 0.7, 1.8),
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function boundedPreference(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function nodeColor(node: GraphNode, groupBy: GroupBy, fallback: string): string {
  if (groupBy === 'folder') return organizerColorOrNull(node.folderColor) ?? fallback
  if (groupBy === 'tag') return organizerColorOrNull(node.tags[0]?.color) ?? fallback
  return fallback
}

function nodeRadius(node: GraphNode, nodeScale: number): number {
  return (4 + Math.min(9, Math.sqrt(node.degree) * 2.4)) * nodeScale
}

function spiralPoint(index: number): { x: number; y: number } {
  const angle = index * 2.399963
  const radius = 18 * Math.sqrt(index)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function stepPhysics(
  nodes: CanvasNode[],
  edges: Array<{ a: CanvasNode; b: CanvasNode }>,
  repulsion: number,
  linkDistance: number,
  held: CanvasNode | null,
): number {
  const grid = new Map<string, CanvasNode[]>()
  for (const node of nodes) {
    const key = `${Math.floor(node.x / SPATIAL_CELL_SIZE)}:${Math.floor(node.y / SPATIAL_CELL_SIZE)}`
    let list = grid.get(key)
    if (!list) { list = []; grid.set(key, list) }
    list.push(node)
  }
  const applyRepulsion = (a: CanvasNode, b: CanvasNode) => {
    let dx = b.x - a.x, dy = b.y - a.y
    let distanceSquared = dx * dx + dy * dy
    if (distanceSquared < 0.01) {
      dx = (Math.random() - 0.5) * 0.6
      dy = (Math.random() - 0.5) * 0.6
      distanceSquared = 0.36
    }
    if (distanceSquared > MAX_REPULSION_DIST_SQ) return
    const distance = Math.sqrt(distanceSquared)
    const force = repulsion / distanceSquared
    const fx = dx / distance * force, fy = dy / distance * force
    a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
  }
  for (const [key, cell] of grid) {
    const colon = key.indexOf(':')
    const cx = Number(key.slice(0, colon))
    const cy = Number(key.slice(colon + 1))
    for (let i = 0; i < cell.length; i++) {
      const a = cell[i]!
      for (let j = i + 1; j < cell.length; j++) {
        applyRepulsion(a, cell[j]!)
      }
    }
    const neighbors = [
      grid.get(`${cx + 1}:${cy}`),
      grid.get(`${cx - 1}:${cy + 1}`),
      grid.get(`${cx}:${cy + 1}`),
      grid.get(`${cx + 1}:${cy + 1}`),
    ]
    for (const neighbor of neighbors) {
      if (!neighbor) continue
      for (let i = 0; i < cell.length; i++) {
        const a = cell[i]!
        for (let j = 0; j < neighbor.length; j++) {
          applyRepulsion(a, neighbor[j]!)
        }
      }
    }
  }
  for (const a of nodes) {
    a.vx -= a.x * 0.0022
    a.vy -= a.y * 0.0022
  }
  for (const edge of edges) {
    const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y
    const distance = Math.hypot(dx, dy) || 1
    const force = (distance - linkDistance) * 0.008
    const fx = dx / distance * force, fy = dy / distance * force
    edge.a.vx += fx; edge.a.vy += fy; edge.b.vx -= fx; edge.b.vy -= fy
  }
  let movement = 0
  for (const node of nodes) {
    if (node.pinned) { node.vx = 0; node.vy = 0; continue }
    if (node === held) continue
    node.vx *= 0.86; node.vy *= 0.86
    const moveX = Math.max(-8, Math.min(8, node.vx))
    const moveY = Math.max(-8, Math.min(8, node.vy))
    node.x += moveX; node.y += moveY
    movement += Math.abs(moveX) + Math.abs(moveY)
  }
  return movement
}

function settleScene(state: CanvasState, prefs: GraphPreferences) {
  for (let index = 0; index < PHYSICS_FRAME_LIMIT; index++) {
    const movement = stepPhysics(
      state.nodes, state.edges, prefs.repulsion, prefs.linkDistance, state.dragging?.node ?? null,
    )
    if (index > 30 && movement < state.nodes.length * 0.03) break
  }
  state.frame = PHYSICS_FRAME_LIMIT
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function persistPreferences(prefs: GraphPreferences): string | null {
  const serialized = JSON.stringify(prefs)
  try {
    localStorage.setItem(GRAPH_PREFS_KEY, serialized)
  } catch {
    // Private browsing or a locked-down browser can reject local preferences.
    return null
  }
  return serialized
}

const DIRECTION: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

export function pickDirectional(nodes: CanvasNode[], from: CanvasNode, key: string): CanvasNode | null {
  const dir = DIRECTION[key]
  if (!dir) return null
  let best: CanvasNode | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (node === from) continue
    const dx = node.x - from.x
    const dy = node.y - from.y
    const along = dx * dir[0] + dy * dir[1]
    if (along <= 0) continue
    const score = along + Math.abs(dx * dir[1] - dy * dir[0]) * 2
    if (score < bestScore) { bestScore = score; best = node }
  }
  return best
}

function normalizedResponse(response: GraphResponse): GraphResponse {
  const nodes = response.nodes.map((node) => ({
    ...node,
    kind: node.kind ?? 'note',
    inDegree: node.inDegree ?? 0,
    outDegree: node.outDegree ?? 0,
    folderId: node.folderId ?? null,
    folderName: node.folderName ?? null,
    folderColor: node.folderColor ?? null,
    tags: node.tags ?? [],
  }))
  return {
    nodes,
    edges: response.edges,
    meta: response.meta ?? {
      mode: 'global', centerId: null, depth: 1,
      totalNodes: nodes.length, totalEdges: response.edges.length,
      truncated: false, limit: nodes.length,
    },
  }
}

export function GraphPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const titleId = useId()
  const [prefs, setPrefs] = useState(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GraphResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [hover, setHover] = useState<CanvasNode | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [context, setContext] = useState<{ x: number; y: number; node: CanvasNode } | null>(null)
  const openNote = useNotes((state) => state.openNote)
  const createNote = useNotes((state) => state.createNote)
  const folders = useNotes((state) => state.folders ?? [])
  const tags = useNotes((state) => state.tags ?? [])
  const hydrated = useNotes((state) => state.hydrated)
  const activeNoteId = useUi((state) => state.activeNoteId)
  const hoverRef = useRef<CanvasNode | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const activeNoteIdRef = useRef(activeNoteId)
  const lastPointerEventAtRef = useRef(Number.NEGATIVE_INFINITY)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const stateRef = useRef<CanvasState>({
    nodes: [], edges: [], scale: 1, offsetX: 0, offsetY: 0,
    dragging: null, pointers: new Map(), pinch: null,
    frame: 0, raf: 0, needsFit: false, palette: FALLBACK_PALETTE,
    emphasis: { id: null, neighbours: new Set<string>() }, schedule: null,
  })

  useEscape(true, onClose)
  useEscape(settingsOpen, () => setSettingsOpen(false))
  useLockScroll(true)
  useDialogFocus(true, panelRef)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 220)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const timer = window.setTimeout(() => persistPreferences(prefs), 300)
    return () => window.clearTimeout(timer)
  }, [prefs])

  useEffect(() => () => {
    persistPreferences(prefsRef.current)
  }, [])

  const centerId = prefs.mode === 'local' ? activeNoteId ?? undefined : undefined
  const folderFilter = prefs.folderId && (!hydrated || folders.some((folder) => folder.id === prefs.folderId))
    ? prefs.folderId
    : ''
  const tagFilter = prefs.tag && (!hydrated || tags.some((item) => item.name === prefs.tag)) ? prefs.tag : ''

  const request: GraphQuery = useMemo(() => ({
    mode: prefs.mode,
    center: centerId,
    depth: prefs.depth,
    q: query || undefined,
    folderId: folderFilter || undefined,
    tag: tagFilter || undefined,
    includeOrphans: prefs.includeOrphans,
    includeUnresolved: prefs.includeUnresolved,
    limit: 350,
  }), [centerId, prefs.mode, prefs.depth, folderFilter, tagFilter, prefs.includeOrphans, prefs.includeUnresolved, query])

  const localBlocked = request.mode === 'local' && !request.center
  const filtersActive = Boolean(query || folderFilter || tagFilter || !prefs.includeOrphans)
  const clearFilters = () => {
    setSearch('')
    setQuery('')
    setPrefs((current) => ({
      ...current,
      folderId: '',
      tag: '',
      includeOrphans: DEFAULT_PREFERENCES.includeOrphans,
    }))
  }

  useEffect(() => {
    if (localBlocked) {
      setData(null)
      setPending(false)
      setLoadError(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setPending(true)
    setLoadError(null)
    api.graph(request, controller.signal).then((response) => {
      if (cancelled) return
      setPending(false)
      setData(normalizedResponse(response))
    }).catch((error) => {
      if (cancelled || (error as Error)?.name === 'AbortError') return
      setPending(false)
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [request, reload, localBlocked])

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId
    stateRef.current.schedule?.()
  }, [activeNoteId])
  useEffect(() => {
    selectedIdRef.current = selectedId
    stateRef.current.schedule?.()
  }, [selectedId])

  const fitGraph = useCallback(() => {
    const canvas = canvasRef.current
    const state = stateRef.current
    if (!canvas || !state.nodes.length) return
    const rect = canvas.getBoundingClientRect()
    const xs = state.nodes.map((node) => node.x)
    const ys = state.nodes.map((node) => node.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const width = Math.max(80, maxX - minX + 80)
    const height = Math.max(80, maxY - minY + 80)
    state.scale = Math.min(2.5, Math.max(0.2, Math.min(rect.width / width, rect.height / height)))
    state.offsetX = rect.width / 2 - ((minX + maxX) / 2) * state.scale
    state.offsetY = rect.height / 2 - ((minY + maxY) / 2) * state.scale
    state.schedule?.()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const state = stateRef.current
    hoverRef.current = null
    setHover(null)
    setSelectedId((current) => data.nodes.some((node) => node.id === current) ? current : null)
    const carried = new Map(state.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
    state.nodes = data.nodes.map((node, index) => {
      const held = carried.get(node.id) ?? spiralPoint(index)
      return {
        ...node,
        x: held.x,
        y: held.y,
        vx: 0,
        vy: 0,
        r: nodeRadius(node, prefs.nodeScale),
      }
    })
    const byId = new Map(state.nodes.map((node) => [node.id, node]))
    state.edges = data.edges.flatMap((edge) => {
      const a = byId.get(edge.source), b = byId.get(edge.target)
      return a && b ? [{ a, b }] : []
    })
    state.frame = 0
    state.needsFit = true
    if (prefersReducedMotion()) settleScene(state, prefsRef.current)
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!state.offsetX && !state.offsetY) {
        state.offsetX = rect.width / 2
        state.offsetY = rect.height / 2
      }
      state.schedule?.()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    state.palette = readPalette()
    const schedule = () => { if (!state.raf) state.raf = requestAnimationFrame(tick) }
    const tick = () => {
      state.raf = 0
      const rect = canvas.getBoundingClientRect()
      if (state.frame < PHYSICS_FRAME_LIMIT) {
        state.frame++
        const movement = stepPhysics(
          state.nodes,
          state.edges,
          prefsRef.current.repulsion,
          prefsRef.current.linkDistance,
          state.dragging?.node ?? null,
        )
        if (state.frame > 30 && movement < state.nodes.length * 0.03) state.frame = PHYSICS_FRAME_LIMIT
      }
      if (state.needsFit && state.frame >= PHYSICS_FRAME_LIMIT) {
        state.needsFit = false
        fitGraph()
      }
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.save()
      ctx.translate(state.offsetX, state.offsetY)
      ctx.scale(state.scale, state.scale)
      const emphasizedId = hoverRef.current?.id ?? selectedIdRef.current
      const palette = state.palette
      if (state.emphasis.id !== (emphasizedId ?? null)) {
        const neighbours = new Set<string>()
        if (emphasizedId) {
          for (const edge of state.edges) {
            if (edge.a.id === emphasizedId) neighbours.add(edge.b.id)
            else if (edge.b.id === emphasizedId) neighbours.add(edge.a.id)
          }
        }
        state.emphasis = { id: emphasizedId ?? null, neighbours }
      }
      ctx.lineWidth = 1 / state.scale
      for (const edge of state.edges) {
        const related = emphasizedId === edge.a.id || emphasizedId === edge.b.id
        const edgeColor = related ? palette.accent : emphasizedId ? palette.edgeDim : palette.edge
        ctx.strokeStyle = edgeColor
        ctx.globalAlpha = related ? 0.95 : 1
        ctx.beginPath(); ctx.moveTo(edge.a.x, edge.a.y); ctx.lineTo(edge.b.x, edge.b.y); ctx.stroke()
        if (prefsRef.current.arrows) {
          const angle = Math.atan2(edge.b.y - edge.a.y, edge.b.x - edge.a.x)
          const x = edge.b.x - Math.cos(angle) * (edge.b.r + 2)
          const y = edge.b.y - Math.sin(angle) * (edge.b.r + 2)
          const size = 5 / Math.sqrt(state.scale)
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x - Math.cos(angle - Math.PI / 6) * size, y - Math.sin(angle - Math.PI / 6) * size)
          ctx.lineTo(x - Math.cos(angle + Math.PI / 6) * size, y - Math.sin(angle + Math.PI / 6) * size)
          ctx.closePath(); ctx.fillStyle = edgeColor; ctx.fill()
        }
      }
      ctx.globalAlpha = 1
      for (const node of state.nodes) {
        const active = node.id === activeNoteIdRef.current
        const emphasized = node.id === emphasizedId
        const inFocus = emphasized || active || state.emphasis.neighbours.has(node.id)
        ctx.globalAlpha = emphasizedId && !inFocus ? 0.55 : 1
        ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
        ctx.fillStyle = active || emphasized ? palette.accent : nodeColor(node, prefsRef.current.groupBy, palette.node)
        if (node.kind === 'unresolved') {
          ctx.strokeStyle = ctx.fillStyle
          ctx.lineWidth = 1.5 / state.scale
          ctx.stroke()
        } else {
          ctx.fill()
        }
        if (node.pinned) {
          ctx.globalAlpha = 1; ctx.strokeStyle = palette.label; ctx.lineWidth = 1 / state.scale
          ctx.beginPath(); ctx.arc(node.x, node.y, node.r + 2.5, 0, Math.PI * 2); ctx.stroke()
        }
        if (active || selectedIdRef.current === node.id) {
          ctx.strokeStyle = palette.accent; ctx.globalAlpha = 0.55; ctx.lineWidth = 3 / state.scale
          ctx.beginPath(); ctx.arc(node.x, node.y, node.r + 4, 0, Math.PI * 2); ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      if (prefsRef.current.labels && (state.scale > 0.68 || emphasizedId)) {
        ctx.font = `${11 / state.scale}px ${palette.font}`
        ctx.textAlign = 'center'
        for (const node of state.nodes) {
          const emphasized = node.id === emphasizedId
          if (!emphasized && node.degree < 1 && state.scale < 1.1) continue
          ctx.fillStyle = emphasized ? palette.accent : palette.label
          ctx.globalAlpha = emphasized || !emphasizedId ? 1 : 0.6
          const label = node.title.length > 18 ? `${truncateText(node.title, 18)}…` : node.title
          ctx.fillText(label, node.x, node.y + node.r + 12 / state.scale)
        }
      }
      ctx.globalAlpha = 1
      ctx.restore()
      if (state.frame < PHYSICS_FRAME_LIMIT) schedule()
    }
    state.schedule = schedule
    schedule()
    const themeObserver = new MutationObserver(() => {
      state.palette = readPalette()
      schedule()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-background'],
    })
    const fitTimer = window.setTimeout(fitGraph, 1500)
    return () => {
      window.clearTimeout(fitTimer)
      cancelAnimationFrame(state.raf)
      state.raf = 0; state.schedule = null
      state.pointers.clear(); state.dragging = null; state.pinch = null
      themeObserver.disconnect()
      observer.disconnect()
    }
  }, [data, fitGraph])

  useEffect(() => {
    for (const node of stateRef.current.nodes) node.r = nodeRadius(node, prefs.nodeScale)
    stateRef.current.schedule?.()
  }, [prefs.nodeScale, data])

  useEffect(() => {
    // Physics-parameter tweaks resume the simulation without rebuilding nodes.
    const state = stateRef.current
    state.frame = Math.min(state.frame, PHYSICS_FRAME_LIMIT - 45)
    state.needsFit = true
    state.schedule?.()
  }, [prefs.linkDistance, prefs.repulsion])

  useEffect(() => {
    // Draw-only toggles just need one repaint.
    stateRef.current.schedule?.()
  }, [prefs.arrows, prefs.labels, prefs.groupBy])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: (clientX - rect.left - state.offsetX) / state.scale, y: (clientY - rect.top - state.offsetY) / state.scale }
  }, [])
  const nodeAt = useCallback((x: number, y: number): CanvasNode | null => {
    const state = stateRef.current
    const slop = 7 / state.scale
    // Squared compare instead of Math.hypot: pointermove fires up to 240 times a second and
    // hypot does overflow scaling work this path never needs.
    for (let index = state.nodes.length - 1; index >= 0; index--) {
      const node = state.nodes[index]!
      const dx = node.x - x
      const dy = node.y - y
      const reach = node.r + slop
      if (dx * dx + dy * dy <= reach * reach) return node
    }
    return null
  }, [])

  const beginDrag = useCallback((clientX: number, clientY: number, button: number) => {
    if (button !== 0) return
    const state = stateRef.current
    const point = toWorld(clientX, clientY)
    const node = nodeAt(point.x, point.y)
    state.dragging = { node, startX: clientX, startY: clientY, ox: state.offsetX, oy: state.offsetY }
    if (node) setSelectedId(node.id)
  }, [nodeAt, toWorld])
  const moveDrag = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const point = toWorld(clientX, clientY)
    if (state.dragging) {
      if (state.dragging.node) {
        state.dragging.node.x = point.x; state.dragging.node.y = point.y
        state.dragging.node.vx = 0; state.dragging.node.vy = 0
        state.frame = Math.min(state.frame, PHYSICS_FRAME_LIMIT - 30)
      } else {
        state.offsetX = state.dragging.ox + clientX - state.dragging.startX
        state.offsetY = state.dragging.oy + clientY - state.dragging.startY
      }
      state.schedule?.(); return
    }
    const node = nodeAt(point.x, point.y)
    if (hoverRef.current?.id !== node?.id) {
      hoverRef.current = node; setHover(node); state.schedule?.()
    }
  }, [nodeAt, toWorld])
  const endDrag = useCallback((clientX: number, clientY: number) => {
    const state = stateRef.current
    const drag = state.dragging
    state.dragging = null
    if (!drag) return
    const moved = Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY)
    if (drag.node && moved >= 5) {
      drag.node.pinned = true
      state.schedule?.()
    }
  }, [])

  const openSelected = useCallback((node: CanvasNode) => {
    if (node.kind === 'unresolved') void createNote?.({ title: node.title, open: true })
    else void openNote(node.id)
    onClose()
  }, [createNote, onClose, openNote])

  const openNodeAt = useCallback((clientX: number, clientY: number) => {
    const point = toWorld(clientX, clientY)
    const node = nodeAt(point.x, point.y)
    if (node) openSelected(node)
  }, [nodeAt, openSelected, toWorld])

  const zoomAt = useCallback((next: number, clientX: number, clientY: number) => {
    const state = stateRef.current
    const canvas = canvasRef.current
    if (!canvas || next === state.scale) return
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    state.offsetX = x - (x - state.offsetX) / state.scale * next
    state.offsetY = y - (y - state.offsetY) / state.scale * next
    state.scale = next
    state.schedule?.()
  }, [])

  const zoomFromCenter = useCallback((next: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [zoomAt])

  const centerOn = useCallback((node: CanvasNode) => {
    const state = stateRef.current
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    state.offsetX = rect.width / 2 - node.x * state.scale
    state.offsetY = rect.height / 2 - node.y * state.scale
    state.schedule?.()
  }, [])

  const releasePointer = useCallback((id: number) => {
    const state = stateRef.current
    state.pointers.delete(id)
    state.dragging = null
    state.pinch = null
    state.schedule?.()
  }, [])

  const selected = data?.nodes.find((node) => node.id === selectedId) ?? null
  const counts = useMemo(() => {
    const unresolved = data?.nodes.filter((node) => node.kind === 'unresolved').length ?? 0
    return { notes: (data?.nodes.length ?? 0) - unresolved, links: data?.edges.length ?? 0, unresolved }
  }, [data])
  const legend = useMemo(() => {
    if (!data || prefs.groupBy === 'none') return []
    const seen = new Map<string, string>()
    for (const node of data.nodes) {
      const name = prefs.groupBy === 'folder' ? node.folderName ?? '' : node.tags[0]?.name ?? ''
      if (!name || seen.has(name)) continue
      const color = nodeColor(node, prefs.groupBy, FALLBACK_PALETTE.node)
      seen.set(name, color)
    }
    return [...seen.entries()].slice(0, 8).map(([name, color]) => ({ name, color }))
  }, [data, prefs.groupBy])
  const menuItems: MenuItem[] = context ? [
    { id: 'open', label: context.node.kind === 'unresolved' ? t('graph.create_note') : t('graph.open_note'), icon: <FolderOpen size={14}/>, onSelect: () => openSelected(context.node) },
    { id: 'right', label: t('graph.open_to_right'), icon: <PanelRightClose size={14}/>, disabled: context.node.kind === 'unresolved', onSelect: () => { void openNote(context.node.id, { pane: 'secondary' }) } },
    { id: 'pin', label: context.node.pinned ? t('graph.unpin') : t('graph.pin'), icon: <CircleDot size={14}/>, separatorBefore: true, onSelect: () => {
      context.node.pinned = !context.node.pinned
      stateRef.current.schedule?.()
    } },
    { id: 'local', label: t('graph.make_local_center'), icon: <CircleDot size={14}/>, disabled: context.node.kind === 'unresolved', onSelect: () => {
      void openNote(context.node.id)
      setPrefs((value) => ({ ...value, mode: 'local' }))
    } },
  ] : []

  const changePref = <K extends keyof GraphPreferences>(key: K, value: GraphPreferences[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }))
  }

  return createPortal(<div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
    className="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none md:py-0">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4">
      <div className="mr-1 flex min-w-0 items-baseline gap-2.5">
        <h2 id={titleId} className="text-[14px] font-semibold tracking-[-0.014em]">{t('common.graph')}</h2>
        {data && <span className="whitespace-nowrap text-[11.5px] text-[var(--text-tertiary)]">
          {counts.unresolved
            ? t('graph.stats_with_unresolved', { notes: counts.notes, links: counts.links, unresolved: counts.unresolved })
            : t('graph.stats', { notes: counts.notes, links: counts.links })}
        </span>}
      </div>
      <div className="flex h-8 items-center rounded-[var(--r-md)] bg-[var(--bg-inset)] p-0.5" role="group" aria-label={t('graph.scope')}>
        <button type="button" aria-pressed={prefs.mode === 'global'} onClick={() => changePref('mode', 'global')}
          className={`h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] ${prefs.mode === 'global' ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-tertiary)]'}`}>
          {t('graph.global')}
        </button>
        <button type="button" aria-pressed={prefs.mode === 'local'} disabled={!activeNoteId} onClick={() => changePref('mode', 'local')}
          className={`h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] disabled:opacity-40 ${prefs.mode === 'local' ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-tertiary)]'}`}>
          {t('graph.local')}
        </button>
      </div>
      <label className="flex h-8 min-w-[150px] flex-1 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 md:max-w-[320px]">
        <Search size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
        <span className="sr-only">{t('graph.search_notes')}</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('graph.search_notes')}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-tertiary)]"/>
        {search && <button type="button" aria-label={t('common.clear')} onClick={() => setSearch('')}><X size={12}/></button>}
      </label>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip label={t('common.zoom_out')}><IconButton label={t('common.zoom_out')} size="sm" disabled={!data?.nodes.length} onClick={() => {
          zoomFromCenter(Math.max(0.2, stateRef.current.scale - 0.2))
        }}><Minus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.fit')}><IconButton label={t('graph.fit')} size="sm" disabled={!data?.nodes.length} onClick={fitGraph}><Maximize2 size={13}/></IconButton></Tooltip>
        <Tooltip label={t('common.zoom_in')}><IconButton label={t('common.zoom_in')} size="sm" disabled={!data?.nodes.length} onClick={() => {
          zoomFromCenter(Math.min(4, stateRef.current.scale + 0.2))
        }}><Plus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.settings')}><IconButton label={t('graph.settings')} size="sm" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={14}/></IconButton></Tooltip>
        <Tooltip label={t('common.close')} combo="escape" side="left"><IconButton label={t('common.close')} size="sm" onClick={onClose} className="ml-1"><X size={16}/></IconButton></Tooltip>
      </div>
    </header>

    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main aria-busy={pending} className="relative min-w-0 flex-1">
        {pending && <div role="status" className="absolute inset-x-0 top-0 h-0.5 bg-[var(--accent)] opacity-60">
          <span className="sr-only">{t('graph.building_graph')}</span>
        </div>}
        {localBlocked ? <Empty art="notes" title={t('graph.local_requires_note')}
          description={t('graph.open_a_note_to_see_its_neighbourhood')}
          action={<Button size="sm" variant="secondary" onClick={() => changePref('mode', 'global')}>{t('graph.use_global')}</Button>}/>
        : loadError ? <Empty art="notes" title={t('graph.could_not_load_graph')} description={loadError}
          action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}/>
        : !data ? <LoadingBlock label={t('graph.building_graph')}/>
        : data.nodes.length === 0 ? (filtersActive
          ? <Empty art="notes" title={t('graph.filtered_empty')} description={t('graph.filtered_empty_hint')}
            action={<Button size="sm" variant="secondary" onClick={clearFilters}>{t('graph.clear_filters')}</Button>}/>
          : <Empty art="notes" title={t('graph.nothing_to_graph_yet')} description={t('graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here')}/>)
        : <>
          <canvas ref={canvasRef} tabIndex={0} role="application" aria-label={t('graph.graph_canvas_accessible')}
            className="size-full touch-none cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return
              lastPointerEventAtRef.current = performance.now()
              event.currentTarget.setPointerCapture(event.pointerId)
              const state = stateRef.current
              state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
              if (state.pointers.size === 1) beginDrag(event.clientX, event.clientY, event.button)
              else if (state.pointers.size === 2) {
                const [a, b] = [...state.pointers.values()]
                state.dragging = null
                state.pinch = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), scale: state.scale, centerX: (a!.x + b!.x) / 2, centerY: (a!.y + b!.y) / 2 }
              }
            }}
            onPointerMove={(event) => {
              lastPointerEventAtRef.current = performance.now()
              const state = stateRef.current
              if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
              if (state.pointers.size >= 2 && state.pinch) {
                const [a, b] = [...state.pointers.values()]
                const distance = Math.hypot(b!.x - a!.x, b!.y - a!.y)
                const next = Math.min(4, Math.max(0.2, state.pinch.scale * distance / Math.max(1, state.pinch.distance)))
                zoomAt(next, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2); return
              }
              moveDrag(event.clientX, event.clientY)
            }}
            onPointerUp={(event) => {
              lastPointerEventAtRef.current = performance.now()
              if (event.button !== 0) return
              const state = stateRef.current
              const wasPinching = state.pointers.size >= 2
              state.pointers.delete(event.pointerId)
              if (state.pointers.size < 2) state.pinch = null
              if (wasPinching) {
                state.dragging = null
                const remaining = [...state.pointers.values()][0]
                if (remaining) beginDrag(remaining.x, remaining.y, 0)
              } else {
                endDrag(event.clientX, event.clientY)
              }
            }}
            onPointerCancel={(event) => releasePointer(event.pointerId)}
            onLostPointerCapture={(event) => releasePointer(event.pointerId)}
            onDoubleClick={(event) => openNodeAt(event.clientX, event.clientY)}
            onMouseDown={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) beginDrag(event.clientX, event.clientY, event.button) }}
            onMouseMove={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) moveDrag(event.clientX, event.clientY) }}
            onMouseUp={(event) => { if (performance.now() - lastPointerEventAtRef.current > 80) endDrag(event.clientX, event.clientY) }}
            onMouseLeave={() => {
              const state = stateRef.current; state.dragging = null
              hoverRef.current = null; setHover(null); state.schedule?.()
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              const point = toWorld(event.clientX, event.clientY)
              const node = nodeAt(point.x, point.y)
              if (node) { setSelectedId(node.id); setContext({ x: event.clientX, y: event.clientY, node }) }
            }}
            onWheel={(event) => {
              const state = stateRef.current
              const next = graphScaleAfterWheel(state.scale, event.deltaY)
              if (next === state.scale) return
              event.preventDefault()
              zoomAt(next, event.clientX, event.clientY)
            }}
            onKeyDown={(event) => {
              const state = stateRef.current
              if (event.key === '+' || event.key === '=') zoomFromCenter(Math.min(4, state.scale + 0.2))
              else if (event.key === '-') zoomFromCenter(Math.max(0.2, state.scale - 0.2))
              else if (event.key === 'Home') fitGraph()
              else if (event.key === 'Enter' && selectedIdRef.current) {
                const node = state.nodes.find((item) => item.id === selectedIdRef.current)
                if (node) openSelected(node)
              }
              else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                const node = state.nodes.find((item) => item.id === selectedIdRef.current)
                if (node) {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setContext({
                    x: rect.left + state.offsetX + node.x * state.scale,
                    y: rect.top + state.offsetY + node.y * state.scale,
                    node,
                  })
                }
              }
              else if (event.key.startsWith('Arrow')) {
                const current = state.nodes.find((item) => item.id === selectedIdRef.current) ?? state.nodes[0]
                const next = current ? pickDirectional(state.nodes, current, event.key) : null
                if (next) { setSelectedId(next.id); centerOn(next) }
              } else return
              event.preventDefault(); state.schedule?.()
            }}/>
          {data.meta.truncated && <div role="status" className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[11px] text-[var(--text-secondary)] shadow-sm">
            {t('graph.showing_limit', { shown: data.nodes.length, total: data.meta.totalNodes })}
          </div>}
          {(hover || selected) && <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]">
            <span className="max-w-[50vw] truncate">{(hover ?? selected)!.title || t('common.untitled_note')}</span>
            <span className="ml-2 text-[var(--text-tertiary)]">{t('graph.direction_counts', { incoming: (hover ?? selected)!.inDegree, outgoing: (hover ?? selected)!.outDegree })}</span>
          </div>}
          <div className="pointer-events-none absolute top-3 left-4 hidden text-[11px] text-[var(--text-tertiary)] md:block">{t('graph.interaction_hint')}</div>
          {(legend.length > 0 || counts.unresolved > 0) && <div role="list" aria-label={t('graph.legend')}
            className="pointer-events-none absolute top-3 right-4 max-w-[42%] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] shadow-[var(--shadow-pop)]">
            {legend.map((item) => <div key={item.name} role="listitem" className="flex min-w-0 items-center gap-1.5 py-0.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: item.color }}/>
              <span className="min-w-0 truncate">{item.name}</span>
            </div>)}
            {counts.unresolved > 0 && <div role="listitem" className="flex min-w-0 items-center gap-1.5 py-0.5">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-[1.5px] border-[var(--graph-node)]"/>
              <span className="min-w-0 truncate">{t('graph.unresolved_legend')}</span>
            </div>}
          </div>}
        </>}
      </main>

      {settingsOpen && <aside aria-label={t('graph.settings')} className="absolute inset-y-0 right-0 z-10 w-[min(88vw,300px)] overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 shadow-[-8px_0_24px_rgba(0,0,0,.06)] md:static md:shadow-none">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-[13px] font-semibold">{t('graph.settings')}</h3><Tooltip label={t('common.close')}><IconButton size="sm" label={t('common.close')} onClick={() => setSettingsOpen(false)}><X size={14}/></IconButton></Tooltip></div>
        <GraphSection icon={<Filter size={13}/>} title={t('graph.filters')}>
          <GraphSelect label={t('graph.folder')} value={folderFilter} onChange={(value) => changePref('folderId', value)} options={[['', t('graph.all_folders')], ...folders.map((folder) => [folder.id, folder.name] as [string, string])]}/>
          <GraphSelect label={t('graph.tag')} value={tagFilter} onChange={(value) => changePref('tag', value)} options={[['', t('graph.all_tags')], ...tags.map((item) => [item.name, item.name] as [string, string])]}/>
          <GraphToggle label={t('graph.show_orphans')} checked={prefs.includeOrphans} onChange={(value) => changePref('includeOrphans', value)}/>
          <GraphToggle label={t('graph.show_unresolved')} checked={prefs.includeUnresolved} onChange={(value) => changePref('includeUnresolved', value)}/>
          {prefs.mode === 'local' && <GraphSelect label={t('graph.depth')} value={String(prefs.depth)} onChange={(value) => changePref('depth', Number(value))} options={[["1", '1'], ["2", '2'], ["3", '3']]}/>} 
        </GraphSection>
        <GraphSection icon={<Network size={13}/>} title={t('graph.appearance')}>
          <GraphSelect label={t('graph.group_by')} value={prefs.groupBy} onChange={(value) => changePref('groupBy', value as GroupBy)} options={[["none", t('graph.group_none')], ["folder", t('graph.folder')], ["tag", t('graph.tag')]]}/>
          <GraphToggle label={t('graph.show_arrows')} checked={prefs.arrows} onChange={(value) => changePref('arrows', value)}/>
          <GraphToggle label={t('graph.show_labels')} checked={prefs.labels} onChange={(value) => changePref('labels', value)}/>
        </GraphSection>
        <GraphSection icon={<ArrowRight size={13}/>} title={t('graph.forces')}>
          <GraphRange label={t('graph.repulsion')} min={300} max={1800} step={50} value={prefs.repulsion} onChange={(value) => changePref('repulsion', value)}/>
          <GraphRange label={t('graph.link_distance')} min={40} max={150} step={5} value={prefs.linkDistance} onChange={(value) => changePref('linkDistance', value)}/>
          <GraphRange label={t('graph.node_size')} min={0.7} max={1.8} step={0.1} value={prefs.nodeScale} onChange={(value) => changePref('nodeScale', value)}/>
          <button type="button" onClick={() => setPrefs((current) => ({ ...DEFAULT_PREFERENCES, mode: current.mode }))} className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ArrowDownToLine size={13}/>{t('graph.restore_defaults')}</button>
        </GraphSection>
      </aside>}
    </div>
    <Menu anchor={context ?? { x: 0, y: 0 }} open={Boolean(context)} onClose={() => setContext(null)} items={menuItems} label={t('graph.node_actions')}/>
  </div>, document.body)
}

function GraphSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="mb-5"><h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">{icon}{title}</h4><div className="space-y-2.5">{children}</div></section>
}

function GraphSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-8 max-w-[160px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]">{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>
}

function GraphToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[var(--accent)]"/></label>
}

function GraphRange({ label, min, max, step, value, onChange }: { label: string; min: number; max: number; step: number; value: number; onChange: (value: number) => void }) {
  return <label className="block text-[12px] text-[var(--text-secondary)]"><span className="mb-1 flex justify-between"><span>{label}</span><span className="tabular-nums text-[var(--text-tertiary)]">{value}</span></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-[var(--accent)]"/></label>
}
