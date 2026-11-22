import type { OfficeFileType } from './constants'
import type { OfficeSnapshot } from './model'

const DATA_IMAGE_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/i

export interface InlineOfficeImage {
  dataUrl: string
  mime: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Best-effort type detection for imported snapshots; the UI still asks when it is ambiguous. */
export function detectOfficeSnapshotType(value: unknown): OfficeFileType | null {
  if (!isRecord(value)) return null
  if (isRecord(value.tables) && (Array.isArray(value.tableOrder) || typeof value.name === 'string')) return 'bases'
  if (Array.isArray(value.pageOrder) && isRecord(value.pages)) return 'boards'
  if (Array.isArray(value.sheetOrder) || (isRecord(value.sheets) && isRecord(value.styles))) return 'sheets'
  if (isRecord(value.body) || isRecord(value.documentStyle) || Array.isArray(value.drawingsOrder)) return 'docs'
  if (Array.isArray(value.pages) && isRecord(value.pageSize)) return 'slides'
  if (Array.isArray(value.pages)) return 'pdfs'
  return null
}

export function findInlineOfficeImages(snapshot: unknown, maxDepth = 32): InlineOfficeImage[] {
  const found = new Map<string, InlineOfficeImage>()

  const walk = (value: unknown, depth: number): void => {
    if (depth > maxDepth || value === null || value === undefined) return
    if (typeof value === 'string') {
      const match = DATA_IMAGE_PREFIX.exec(value)
      if (!match || value.length <= match[0].length) return
      const dataUrl = value
      if (found.has(dataUrl)) return
      found.set(dataUrl, { dataUrl, mime: `image/${match[1]!.toLowerCase()}` })
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item, depth + 1)
    }
  }

  walk(snapshot, 0)
  return [...found.values()]
}

/**
 * Returns a new snapshot with every inline image replaced. The input is never mutated, so a failed
 * upload can leave the live editor untouched.
 */
export function replaceInlineOfficeImages(
  snapshot: unknown,
  mapping: ReadonlyMap<string, string>,
  maxDepth = 32,
): unknown {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > maxDepth || value === null || value === undefined) return value
    if (typeof value === 'string') return mapping.get(value) ?? value
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) out[key] = walk(item, depth + 1)
      return out
    }
    return value
  }
  return walk(snapshot, 0)
}

export function asOfficeSnapshot(value: unknown): OfficeSnapshot | null {
  return isRecord(value) ? value as OfficeSnapshot : null
}