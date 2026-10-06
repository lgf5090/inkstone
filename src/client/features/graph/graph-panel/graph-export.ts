import type { GraphPreferences } from '../../../lib/graph-settings'
import {
  GRAPH_EXPORT_MAX_EDGE,
  GRAPH_EXPORT_PADDING,
  GRAPH_EXPORT_SCALE,
  GRAPH_LABEL_FONT_SIZE,
  GRAPH_LABEL_OFFSET,
  GRAPH_PIN_RING_GAP,
  GRAPH_SELECTED_RING_GAP,
} from './constants'
import { arrowHeadPoints, arrowHeadSize, drawScene } from './draw'
import { graphLabelVisible, graphNodeLabel, nodeColor } from './scene'
import type { CanvasNode, CanvasState, Palette } from './types'

export type GraphExportKind = 'png' | 'svg'

export interface GraphExportBounds {
  minX: number
  minY: number
  width: number
  height: number
}

const SVG_MIME = 'image/svg+xml;charset=utf-8'
const PNG_MIME = 'image/png'
const EXPORT_DRAW_SCALE = 1

export function graphExportBounds(nodes: readonly CanvasNode[], labels: boolean): GraphExportBounds {
  if (!nodes.length) {
    return { minX: 0, minY: 0, width: GRAPH_EXPORT_PADDING * 2, height: GRAPH_EXPORT_PADDING * 2 }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const node of nodes) {
    const label = labels && graphLabelVisible(node, EXPORT_DRAW_SCALE)
      ? GRAPH_LABEL_FONT_SIZE + GRAPH_LABEL_OFFSET
      : 0
    minX = Math.min(minX, node.x - node.r)
    maxX = Math.max(maxX, node.x + node.r)
    minY = Math.min(minY, node.y - node.r)
    maxY = Math.max(maxY, node.y + node.r + label)
  }
  return {
    minX: minX - GRAPH_EXPORT_PADDING,
    minY: minY - GRAPH_EXPORT_PADDING,
    width: maxX - minX + GRAPH_EXPORT_PADDING * 2,
    height: maxY - minY + GRAPH_EXPORT_PADDING * 2,
  }
}

export function graphExportGeometry(bounds: GraphExportBounds): { scale: number; width: number; height: number } {
  const scale = Math.min(GRAPH_EXPORT_SCALE, GRAPH_EXPORT_MAX_EDGE / Math.max(1, bounds.width, bounds.height))
  return {
    scale,
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
  }
}

export function graphExportFilename(mode: GraphPreferences['mode'], kind: GraphExportKind): string {
  return `graph-${mode}.${kind}`
}

export function exportTitlesVisible(prefs: GraphPreferences): boolean {
  return prefs.labels && !prefs.exportWithoutTitles
}

export function graphExportSvg(state: CanvasState, colors: Palette, prefs: GraphPreferences): string {
  const labels = exportTitlesVisible(prefs)
  const bounds = graphExportBounds(state.nodes, labels)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(bounds.width)}" height="${num(bounds.height)}"`
      + ` viewBox="${num(bounds.minX)} ${num(bounds.minY)} ${num(bounds.width)} ${num(bounds.height)}">`,
  ]
  if (!prefs.exportTransparentBackground) {
    parts.push(`<rect x="${num(bounds.minX)}" y="${num(bounds.minY)}" width="${num(bounds.width)}"`
      + ` height="${num(bounds.height)}" fill="${attr(colors.background)}"/>`)
  }
  for (const edge of state.edges) {
    parts.push(`<line x1="${num(edge.a.x)}" y1="${num(edge.a.y)}" x2="${num(edge.b.x)}" y2="${num(edge.b.y)}"`
      + ` stroke="${attr(colors.edge)}" stroke-width="1" opacity="0.42"/>`)
    if (prefs.arrows) parts.push(svgArrowHead(edge.a, edge.b, colors.edge))
  }
  for (const node of state.nodes) parts.push(svgNode(node, colors, prefs))
  if (labels) {
    for (const node of state.nodes) {
      if (graphLabelVisible(node, EXPORT_DRAW_SCALE)) parts.push(svgLabel(node, colors))
    }
  }
  parts.push('</svg>')
  return `${parts.join('\n')}\n`
}

function svgArrowHead(from: CanvasNode, to: CanvasNode, color: string): string {
  const corners = arrowHeadPoints(from, to, arrowHeadSize(EXPORT_DRAW_SCALE))
    .map(([x, y]) => `${num(x)} ${num(y)}`)
    .join(' ')
  return `<polygon points="${corners}" fill="${attr(color)}"/>`
}

function svgNode(node: CanvasNode, colors: Palette, prefs: GraphPreferences): string {
  const fill = attr(nodeColor(node, prefs.groupBy, colors.node))
  const circle = `<circle cx="${num(node.x)}" cy="${num(node.y)}" r="${num(node.r)}"`
  if (node.kind === 'unresolved') return `${circle} fill="none" stroke="${fill}" stroke-width="1.5"/>`
  const parts = [`${circle} fill="${fill}"/>`]
  if (node.pinned) {
    parts.push(`<circle cx="${num(node.x)}" cy="${num(node.y)}" r="${num(node.r + GRAPH_PIN_RING_GAP)}"`
      + ` fill="none" stroke="${attr(colors.label)}" stroke-width="1"/>`)
  }
  if (node.kind === 'tag') {
    parts.push(`<circle cx="${num(node.x)}" cy="${num(node.y)}" r="${num(node.r + GRAPH_SELECTED_RING_GAP)}"`
      + ` fill="none" stroke="${fill}" stroke-width="1.5"/>`)
  }
  return parts.join('\n')
}

function svgLabel(node: CanvasNode, colors: Palette): string {
  const y = num(node.y + node.r + GRAPH_LABEL_OFFSET / EXPORT_DRAW_SCALE)
  return `<text x="${num(node.x)}" y="${y}" font-family="${attr(colors.font)}" font-size="${GRAPH_LABEL_FONT_SIZE}"`
    + ` text-anchor="middle" fill="${attr(colors.label)}" stroke="${attr(colors.background)}"`
    + ` stroke-width="3" paint-order="stroke">${escapeXml(graphNodeLabel(node))}</text>`
}

export async function graphExportPng(
  state: CanvasState,
  colors: Palette,
  prefs: GraphPreferences,
): Promise<Blob> {
  const labels = exportTitlesVisible(prefs)
  const bounds = graphExportBounds(state.nodes, labels)
  const geometry = graphExportGeometry(bounds)
  const canvas = document.createElement('canvas')
  canvas.width = geometry.width
  canvas.height = geometry.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas-2d-unavailable')
  ctx.setTransform(geometry.scale, 0, 0, geometry.scale,
    -bounds.minX * geometry.scale, -bounds.minY * geometry.scale)
  if (!prefs.exportTransparentBackground) {
    ctx.fillStyle = colors.background
    ctx.fillRect(bounds.minX, bounds.minY, bounds.width, bounds.height)
  }
  drawScene({
    ctx,
    state: { ...state, searchHits: null },
    colors,
    groupBy: prefs.groupBy,
    arrows: prefs.arrows,
    labels,
    emphasizedId: null,
    neighborIds: new Set<string>(),
    activeNoteId: null,
    selectedId: null,
    scale: EXPORT_DRAW_SCALE,
  })
  return await canvasToPng(canvas)
}

export async function runGraphExport(
  state: CanvasState,
  colors: Palette,
  prefs: GraphPreferences,
  kind: GraphExportKind,
): Promise<void> {
  const blob = kind === 'svg'
    ? new Blob([graphExportSvg(state, colors, prefs)], { type: SVG_MIME })
    : await graphExportPng(state, colors, prefs)
  saveBlob(blob, graphExportFilename(prefs.mode, kind))
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('png-encode-failed'))
    }, PNG_MIME)
  })
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character)
}

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function attr(value: string): string {
  return escapeXml(value.trim())
}
