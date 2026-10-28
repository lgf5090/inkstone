/** Colour validation shared by the canvas, the import adapters and the worker. */
import { PAPER_SURFACE_BY_ID, type InknotePaperSurface } from './constants'

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export function normalizeInknoteColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!HEX_RE.test(trimmed)) return null
  const hex = trimmed.slice(1).toLowerCase()
  if (hex.length === 3) return `#${hex.split('').map((c) => c + c).join('')}`
  if (hex.length === 4) return `#${hex.split('').map((c) => c + c).join('')}`
  return `#${hex}`
}

export function isInknoteColor(value: unknown): value is string {
  return normalizeInknoteColor(value) !== null
}

export function normalizePaperColor(value: unknown): string | null {
  if (typeof value === 'string' && PAPER_SURFACE_BY_ID.has(value)) return value
  return normalizeInknoteColor(value)
}

export function paperSurfaceFor(color: string): InknotePaperSurface {
  const named = PAPER_SURFACE_BY_ID.get(color)
  if (named) return named
  const normalized = normalizeInknoteColor(color)
  if (!normalized) return PAPER_SURFACE_BY_ID.get('white')!
  const hex = normalized.slice(1)
  const channels = hex.length >= 6
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : [parseInt(hex[0]! + hex[0]!, 16), parseInt(hex[1]! + hex[1]!, 16), parseInt(hex[2]! + hex[2]!, 16)]
  const [r, g, b] = channels as [number, number, number]
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  const dark = luminance < 0.4
  const ink = dark ? 'rgba(255,255,255,' : 'rgba(60,80,110,'
  return {
    id: normalized,
    nameKey: 'inknote.paper.custom',
    bg: normalized,
    dark,
    line: `${ink}.34)`,
    grid: `${ink}.29)`,
    dot: `${ink}.43)`,
  }
}

export function inkColorForPaper(paperColor: string, preferred: string): string {
  const surface = paperSurfaceFor(paperColor)
  if (!surface.dark) return preferred
  const normalized = normalizeInknoteColor(preferred) ?? '#1e293b'
  const hex = normalized.slice(1, 7)
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 160 ? '#f8fafc' : preferred
}
