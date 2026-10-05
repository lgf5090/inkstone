import {
  GRAPH_DIM_ALPHA,
  GRAPH_LABEL_DIM_ALPHA,
  GRAPH_LABEL_FONT_SIZE,
  GRAPH_LABEL_MIN_SCALE,
  GRAPH_LABEL_OFFSET,
  GRAPH_MATCH_RING_GAP,
  GRAPH_PIN_RING_GAP,
  GRAPH_RING_WIDTH,
  GRAPH_SELECTED_RING_GAP,
  GRAPH_SELECTED_RING_WIDTH,
} from './constants'
import { graphLabelVisible, graphNodeLabel, nodeColor } from './scene'
import type { CanvasEdge, CanvasNode, CanvasState, Palette } from './types'
import type { GroupBy } from '../../../lib/graph-settings'

export function arrowHeadPoints(
  from: CanvasNode,
  to: CanvasNode,
  size: number,
): Array<[number, number]> {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const x = to.x - Math.cos(angle) * (to.r + 2)
  const y = to.y - Math.sin(angle) * (to.r + 2)
  return [
    [x, y],
    [x - Math.cos(angle - Math.PI / 6) * size, y - Math.sin(angle - Math.PI / 6) * size],
    [x - Math.cos(angle + Math.PI / 6) * size, y - Math.sin(angle + Math.PI / 6) * size],
  ]
}

export function arrowHeadSize(scale: number): number {
  return Math.max(4, 5 / Math.sqrt(scale))
}

export function drawEdges(options: {
  ctx: CanvasRenderingContext2D
  edges: readonly CanvasEdge[]
  color: string
  alpha: number
  arrows: boolean
  scale: number
}): void {
  const { ctx, edges, color, alpha, arrows, scale } = options
  if (!edges.length) return
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.beginPath()
  for (const edge of edges) {
    ctx.moveTo(edge.a.x, edge.a.y)
    ctx.lineTo(edge.b.x, edge.b.y)
  }
  ctx.stroke()
  if (!arrows) return
  const size = arrowHeadSize(scale)
  ctx.fillStyle = color
  ctx.beginPath()
  for (const edge of edges) {
    const [head, left, right] = arrowHeadPoints(edge.a, edge.b, size)
    ctx.moveTo(head![0], head![1])
    ctx.lineTo(left![0], left![1])
    ctx.lineTo(right![0], right![1])
    ctx.closePath()
  }
  ctx.fill()
}

export function partitionEdges(
  edges: readonly CanvasEdge[],
  emphasizedId: string | null,
): { related: CanvasEdge[]; dimmed: CanvasEdge[]; plain: CanvasEdge[] } {
  const related: CanvasEdge[] = []
  const dimmed: CanvasEdge[] = []
  const plain: CanvasEdge[] = []
  for (const edge of edges) {
    if (emphasizedId && (edge.a.id === emphasizedId || edge.b.id === emphasizedId)) related.push(edge)
    else if (emphasizedId) dimmed.push(edge)
    else plain.push(edge)
  }
  return { related, dimmed, plain }
}

export function drawNodes(options: {
  ctx: CanvasRenderingContext2D
  nodes: readonly CanvasNode[]
  colors: Palette
  groupBy: GroupBy
  emphasizedId: string | null
  neighborIds: ReadonlySet<string>
  activeNoteId: string | null
  selectedId: string | null
  searchHits: ReadonlySet<string> | null
  scale: number
}): void {
  const {
    ctx, nodes, colors, groupBy, emphasizedId, neighborIds,
    activeNoteId, selectedId, searchHits, scale,
  } = options
  for (const node of nodes) {
    const active = node.id === activeNoteId
    const emphasized = node.id === emphasizedId
    const inFocus = emphasized || active || neighborIds.has(node.id)
    ctx.globalAlpha = emphasizedId && !inFocus ? GRAPH_DIM_ALPHA : 1
    ctx.beginPath(); ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
    ctx.fillStyle = active || emphasized ? colors.accent : nodeColor(node, groupBy, colors.node)
    if (node.kind === 'unresolved') {
      ctx.strokeStyle = ctx.fillStyle as string
      ctx.lineWidth = GRAPH_RING_WIDTH / scale
      ctx.stroke()
    } else {
      ctx.fill()
    }
    if (node.pinned) {
      ctx.globalAlpha = 1; ctx.strokeStyle = colors.label; ctx.lineWidth = 1 / scale
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r + GRAPH_PIN_RING_GAP, 0, Math.PI * 2); ctx.stroke()
    }
    if (searchHits?.has(node.id)) {
      ctx.globalAlpha = 1; ctx.strokeStyle = colors.accent; ctx.lineWidth = 2 / scale
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r + GRAPH_MATCH_RING_GAP, 0, Math.PI * 2); ctx.stroke()
    }
    if (active || selectedId === node.id) {
      ctx.strokeStyle = colors.accent; ctx.globalAlpha = 0.55; ctx.lineWidth = GRAPH_SELECTED_RING_WIDTH / scale
      ctx.beginPath(); ctx.arc(node.x, node.y, node.r + GRAPH_SELECTED_RING_GAP, 0, Math.PI * 2); ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}

export function labelsVisible(labels: boolean, scale: number, emphasizedId: string | null): boolean {
  return labels && (scale > GRAPH_LABEL_MIN_SCALE || Boolean(emphasizedId))
}

export function labelY(node: CanvasNode, scale: number): number {
  return node.y + node.r + GRAPH_LABEL_OFFSET / scale
}

export function drawLabels(options: {
  ctx: CanvasRenderingContext2D
  nodes: readonly CanvasNode[]
  colors: Palette
  emphasizedId: string | null
  scale: number
  labels: boolean
}): void {
  const { ctx, nodes, colors, emphasizedId, scale, labels } = options
  if (!labelsVisible(labels, scale, emphasizedId)) return
  ctx.font = `${GRAPH_LABEL_FONT_SIZE / scale}px ${colors.font}`
  ctx.textAlign = 'center'
  for (const node of nodes) {
    const emphasized = node.id === emphasizedId
    if (!emphasized && !graphLabelVisible(node, scale)) continue
    ctx.fillStyle = emphasized ? colors.accent : colors.label
    ctx.globalAlpha = emphasized || !emphasizedId ? 1 : GRAPH_LABEL_DIM_ALPHA
    ctx.fillText(graphNodeLabel(node), node.x, labelY(node, scale))
  }
  ctx.globalAlpha = 1
}

export interface SceneDrawOptions {
  ctx: CanvasRenderingContext2D
  state: CanvasState
  colors: Palette
  groupBy: GroupBy
  arrows: boolean
  labels: boolean
  emphasizedId: string | null
  neighborIds: ReadonlySet<string>
  activeNoteId: string | null
  selectedId: string | null
  scale: number
}

export function drawScene(options: SceneDrawOptions): void {
  const { ctx, state, colors, scale, emphasizedId } = options
  const { related, dimmed, plain } = partitionEdges(state.edges, emphasizedId)
  ctx.lineWidth = 1 / scale
  drawEdges({ ctx, edges: related, color: colors.accent, alpha: 0.95, arrows: options.arrows, scale })
  drawEdges({ ctx, edges: dimmed, color: colors.edgeDim, alpha: 1, arrows: options.arrows, scale })
  drawEdges({ ctx, edges: plain, color: colors.edge, alpha: 1, arrows: options.arrows, scale })
  ctx.globalAlpha = 1
  drawNodes({
    ctx,
    nodes: state.nodes,
    colors,
    groupBy: options.groupBy,
    emphasizedId,
    neighborIds: options.neighborIds,
    activeNoteId: options.activeNoteId,
    selectedId: options.selectedId,
    searchHits: state.searchHits,
    scale,
  })
  drawLabels({
    ctx,
    nodes: state.nodes,
    colors,
    emphasizedId,
    scale,
    labels: options.labels,
  })
}
