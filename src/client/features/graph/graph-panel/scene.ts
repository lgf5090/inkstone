import type { GraphNode, GraphResponse } from '@shared/types'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { truncateText } from '@shared/text-utils'
import type { GraphColorGroup, GraphPreferences, GroupBy } from '../../../lib/graph-settings'
import {
  GRAPH_CLICK_TRAVEL_MIN,
  GRAPH_FIT_PADDING,
  GRAPH_HIT_SLOP,
  GRAPH_LABEL_FONT_SIZE,
  GRAPH_LABEL_MAX,
  GRAPH_LABEL_OFFSET,
  GRAPH_LABEL_ORPHAN_SCALE,
  GRAPH_MAX_SCALE,
  GRAPH_MIN_SCALE,
  GRAPH_RESUME_FRAMES,
  GRAPH_SETTLE_FIRST_FRAME,
  GRAPH_SETTLE_MOVEMENT,
  GRAPH_WHEEL_IN,
  GRAPH_WHEEL_OUT,
  MAX_REPULSION_DIST_SQ,
  PHYSICS_FRAME_LIMIT,
  SPIRAL_ANGLE,
  SPIRAL_RADIUS,
  SPATIAL_CELL_SIZE,
} from './constants'
import type { CanvasEdge, CanvasNode, CanvasState, Palette } from './types'

export const FALLBACK_PALETTE: Palette = {
  edge: '#6b7280',
  edgeDim: '#9ca3af',
  node: '#777777',
  accent: '#4f46e5',
  label: '#555555',
  font: 'sans-serif',
  background: '#ffffff',
}

export function readPalette(): Palette {
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
    background: token('--bg-base', FALLBACK_PALETTE.background),
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function nodeRadius(node: GraphNode, nodeScale: number): number {
  return (4 + Math.min(9, Math.sqrt(node.degree) * 2.4)) * nodeScale
}

export function spiralPoint(index: number): { x: number; y: number } {
  const angle = index * SPIRAL_ANGLE
  const radius = SPIRAL_RADIUS * Math.sqrt(index)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

export function graphNodeLabel(node: GraphNode): string {
  return node.title.length > GRAPH_LABEL_MAX ? `${truncateText(node.title, GRAPH_LABEL_MAX)}…` : node.title
}

export function graphLabelVisible(node: CanvasNode, scale: number): boolean {
  return node.degree >= 1 || scale >= GRAPH_LABEL_ORPHAN_SCALE
}

export function matchedColorGroup(
  node: GraphNode,
  groups: readonly GraphColorGroup[],
): string | null {
  for (const group of groups) {
    if (matchesColorGroup(node, group.query)) return group.color
  }
  return null
}

export function matchesColorGroup(node: GraphNode, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return false
  const haystack = [
    node.title,
    node.folderName ?? '',
    ...node.tags.map((tag) => tag.name),
  ].join(' ').toLowerCase()
  return needle.split(/\s+/).every((term) => haystack.includes(term))
}

export function nodeColor(node: CanvasNode, groupBy: GroupBy, fallback: string): string {
  if (node.colorGroup) return node.colorGroup
  if (groupBy === 'folder') return organizerColorOrNull(node.folderColor) ?? fallback
  if (groupBy === 'tag') return organizerColorOrNull(node.tags[0]?.color) ?? fallback
  return fallback
}

export function buildSceneNodes(
  response: GraphResponse,
  prefs: Pick<GraphPreferences, 'nodeScale' | 'groupBy' | 'colorGroups'>,
  carried: ReadonlyMap<string, { x: number; y: number }>,
  pinnedIds: readonly string[],
): CanvasNode[] {
  const pinned = new Set(pinnedIds)
  return response.nodes.map((node, index) => {
    const held = carried.get(node.id) ?? spiralPoint(index)
    return {
      ...node,
      x: held.x,
      y: held.y,
      vx: 0,
      vy: 0,
      r: nodeRadius(node, prefs.nodeScale),
      pinned: pinned.has(node.id),
      colorGroup: matchedColorGroup(node, prefs.colorGroups),
    }
  })
}

export function buildSceneEdges(response: GraphResponse, nodes: readonly CanvasNode[]): CanvasEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return response.edges.flatMap((edge) => {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    return a && b ? [{ a, b }] : []
  })
}

export function stampColorGroups(
  nodes: readonly CanvasNode[],
  colorGroups: readonly GraphColorGroup[],
): void {
  for (const node of nodes) node.colorGroup = matchedColorGroup(node, colorGroups)
}

export function stepPhysics(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
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

export function settledInTime(frame: number, movement: number, nodeCount: number): boolean {
  return frame > GRAPH_SETTLE_FIRST_FRAME && movement < nodeCount * GRAPH_SETTLE_MOVEMENT
}

export function settleScene(state: CanvasState, prefs: Pick<GraphPreferences, 'repulsion' | 'linkDistance'>): void {
  for (let index = 0; index < PHYSICS_FRAME_LIMIT; index++) {
    const movement = stepPhysics(state.nodes, state.edges, prefs.repulsion, prefs.linkDistance, state.dragging?.node ?? null)
    if (settledInTime(index, movement, state.nodes.length)) break
  }
  state.frame = PHYSICS_FRAME_LIMIT
}

export function resumeScene(state: CanvasState, frames = GRAPH_RESUME_FRAMES): void {
  state.frame = Math.min(state.frame, PHYSICS_FRAME_LIMIT - frames)
}

export const DIRECTION: Record<string, readonly [number, number]> = {
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

export function graphScaleAfterWheel(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return scale
  const next = deltaY > 0 ? scale * GRAPH_WHEEL_OUT : scale * GRAPH_WHEEL_IN
  return Math.min(GRAPH_MAX_SCALE, Math.max(GRAPH_MIN_SCALE, next))
}

export function nodeAtPoint(nodes: readonly CanvasNode[], x: number, y: number, scale: number): CanvasNode | null {
  const slop = GRAPH_HIT_SLOP / scale
  // Squared compare instead of Math.hypot: pointermove fires up to 240 times a second and
  // hypot does overflow scaling work this path never needs.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!
    const dx = node.x - x
    const dy = node.y - y
    const reach = node.r + slop
    if (dx * dx + dy * dy <= reach * reach) return node
  }
  return null
}

export function dragMovedEnough(clientX: number, clientY: number, drag: { startX: number; startY: number }): boolean {
  return Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY) >= GRAPH_CLICK_TRAVEL_MIN
}

export function neighbourIds(edges: readonly CanvasEdge[], id: string): Set<string> {
  const neighbours = new Set<string>()
  for (const edge of edges) {
    if (edge.a.id === id) neighbours.add(edge.b.id)
    else if (edge.b.id === id) neighbours.add(edge.a.id)
  }
  return neighbours
}

export function labelReservedHeight(node: CanvasNode, scale: number): number {
  return graphLabelVisible(node, scale) ? GRAPH_LABEL_FONT_SIZE + GRAPH_LABEL_OFFSET : 0
}

export function normalizedResponse(response: GraphResponse): GraphResponse {
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
      truncated: nodes.length >= 350, limit: 350,
    },
  }
}

export interface GraphCounts {
  notes: number
  links: number
  tags: number
  unresolved: number
}

export function graphCounts(response: GraphResponse | null): GraphCounts {
  const nodes = response?.nodes ?? []
  const unresolved = nodes.filter((node) => node.kind === 'unresolved').length
  const tags = new Set(nodes.filter((node) => node.kind === 'tag').map((node) => node.id)).size
  return {
    notes: nodes.length - unresolved - tags,
    links: response?.edges.length ?? 0,
    tags,
    unresolved,
  }
}

export function graphSearchHits(nodes: readonly GraphNode[], query: string): Set<string> | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const hits = nodes.filter((node) => node.title.toLowerCase().includes(needle)).map((node) => node.id)
  return hits.length ? new Set(hits) : null
}

export interface GraphNeighbours {
  incoming: GraphNode[]
  outgoing: GraphNode[]
}

export function graphNeighbours(response: GraphResponse, id: string): GraphNeighbours {
  const byId = new Map(response.nodes.map((node) => [node.id, node]))
  const incoming: GraphNode[] = []
  const outgoing: GraphNode[] = []
  const seenIn = new Set<string>()
  const seenOut = new Set<string>()
  for (const edge of response.edges) {
    if (edge.target === id && !seenIn.has(edge.source)) {
      const node = byId.get(edge.source)
      if (node) { seenIn.add(edge.source); incoming.push(node) }
    } else if (edge.source === id && !seenOut.has(edge.target)) {
      const node = byId.get(edge.target)
      if (node) { seenOut.add(edge.target); outgoing.push(node) }
    }
  }
  return { incoming, outgoing }
}

export interface GraphNeighbourGroup {
  key: 'incoming' | 'outgoing'
  nodes: GraphNode[]
  hidden: number
}

export function graphNeighbourGroups(
  neighbours: GraphNeighbours,
  max: number,
): GraphNeighbourGroup[] {
  return [
    { key: 'incoming' as const, nodes: neighbours.incoming },
    { key: 'outgoing' as const, nodes: neighbours.outgoing },
  ]
    .filter((group) => group.nodes.length > 0)
    .map((group) => ({
      key: group.key,
      nodes: group.nodes.slice(0, max),
      hidden: Math.max(0, group.nodes.length - max),
    }))
}

export type LegendKind = 'folder' | 'tag' | 'rule'

export interface ColorLegendItem {
  label: string
  color: string
  kind: LegendKind
  value: string
}

export function colorLegends(
  nodes: readonly GraphNode[],
  groupBy: GroupBy,
  colorGroups: readonly GraphColorGroup[],
  limit: number,
): ColorLegendItem[] {
  const items: ColorLegendItem[] = []
  const seen = new Set<string>()
  const push = (item: ColorLegendItem) => {
    const key = `${item.kind}:${item.value}`
    if (seen.has(key) || !item.value || !item.label) return
    seen.add(key)
    items.push(item)
  }
  for (const group of colorGroups) push({ label: group.query, color: group.color, kind: 'rule', value: group.id })
  for (const node of nodes) {
    if (items.length >= limit) break
    if (groupBy === 'folder' && node.folderName) {
      push({
        label: node.folderName,
        color: organizerColorOrNull(node.folderColor) ?? FALLBACK_PALETTE.node,
        kind: 'folder',
        value: node.folderId ?? '',
      })
    } else if (groupBy === 'tag') {
      const tag = node.tags[0]
      if (tag) {
        push({
          label: tag.name,
          color: organizerColorOrNull(tag.color) ?? FALLBACK_PALETTE.node,
          kind: 'tag',
          value: tag.name,
        })
      }
    }
  }
  return items.slice(0, limit)
}

export interface ViewportFit {
  scale: number
  offsetX: number
  offsetY: number
}

export function fitBounds(
  nodes: readonly { x: number; y: number }[],
  width: number,
  height: number,
  maxScale: number,
  minScale: number,
): ViewportFit | null {
  if (!nodes.length) return null
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const boxWidth = Math.max(80, maxX - minX + GRAPH_FIT_PADDING * 2)
  const boxHeight = Math.max(80, maxY - minY + GRAPH_FIT_PADDING * 2)
  const scale = Math.min(maxScale, Math.max(minScale, Math.min(width / boxWidth, height / boxHeight)))
  return {
    scale,
    offsetX: width / 2 - ((minX + maxX) / 2) * scale,
    offsetY: height / 2 - ((minY + maxY) / 2) * scale,
  }
}
