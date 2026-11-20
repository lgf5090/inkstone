import { downloadBlob, downloadTextFile } from './export-utils'
import type { FlowEdgeDef, FlowNodeLayout } from './flow-layout'

export interface FlowExportNode {
  title: string
  lines: string[]
  highlightLines?: Set<number>
}

interface FlowPalette {
  accent: string
  border: string
  surface: string
  text: string
  muted: string
  background: string
}

interface EdgeGeometry {
  d: string
  labelX: number
  labelY: number
}

export const FLOW_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace'

const EXPORT_PADDING = 24
const EXPORT_MIN_WIDTH = 320
const EXPORT_MIN_HEIGHT = 200
const EXPORT_HEADER_HEIGHT = 28
const EXPORT_ROW_HEIGHT = 19
const EXPORT_HEADER_BASELINE = 18
const EXPORT_FIRST_ROW_BASELINE = 41
const ARROW_MARKER_ID = 'arrow'
const COLOR_FALLBACK = {
  accent: '#8b5cf6',
  border: '#e4e4e7',
  surface: '#ffffff',
  text: '#18181b',
  muted: '#71717a',
  background: '#ffffff',
} as const

export function edgeGeometry(source: FlowNodeLayout, target: FlowNodeLayout): EdgeGeometry {
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

export function readFlowPalette(): FlowPalette {
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

export function buildExportSvg(
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
        `<text x="${x + 10}" y="${y + EXPORT_HEADER_BASELINE}" font-family="${FLOW_FONT_FAMILY}" font-size="11" font-weight="600" fill="${palette.text}">${escapeXml(info.title)}</text>`,
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
          `<text x="${x + 10}" y="${lineY}" font-family="${FLOW_FONT_FAMILY}" font-size="9.5" fill="${highlighted ? palette.accent : palette.muted}">${escapeXml(line)}</text>`,
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
        ? `<text x="${geometry.labelX}" y="${geometry.labelY}" font-family="${FLOW_FONT_FAMILY}" font-size="9" fill="${palette.muted}" text-anchor="middle">${escapeXml(edge.label)}</text>`
        : ''
      return `<path d="${geometry.d}" fill="none" stroke="${palette.accent}" stroke-width="1.2" opacity="0.65" marker-end="url(#${ARROW_MARKER_ID})"/>${label}`
    })
    .join('')

  const marker = `<marker id="${ARROW_MARKER_ID}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${palette.accent}"/></marker>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${marker}</defs><rect width="${width}" height="${height}" fill="${palette.background}"/>${edgeShapes}${nodeShapes}</svg>`
  return { svg, width, height }
}

export function safeFileBase(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'flow'
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

export async function downloadFlowPng(
  nodes: FlowNodeLayout[],
  edges: FlowEdgeDef[],
  exportNode: (id: string) => FlowExportNode | null,
  exportName: string,
): Promise<void> {
  const palette = readFlowPalette()
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
  downloadBlob(`${safeFileBase(exportName)}.png`, blob)
}

export function downloadFlowSvg(
  nodes: FlowNodeLayout[],
  edges: FlowEdgeDef[],
  exportNode: (id: string) => FlowExportNode | null,
  exportName: string,
): void {
  const { svg } = buildExportSvg(nodes, edges, exportNode, readFlowPalette())
  downloadTextFile(`${safeFileBase(exportName)}.svg`, svg, 'image/svg+xml')
}