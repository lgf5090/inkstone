/** The page envelope, its strict validator, and the adapter for note2's v4 import files. */
import {
  INKNOTE_ASSET_ID_RE,
  INKNOTE_ASSET_URL_PREFIX,
  INKNOTE_LIMITS,
} from './constants'
import { normalizeInknoteColor } from './color'
import { INKNOTE_PAGE_FORMAT, INKNOTE_PAGE_VERSION, type InknoteImage,
  InknotePageBackground,
  InknotePageContent,
  InknotePoint,
  InknoteShapeKind,
  InknoteStroke,
  InknoteTextBox,
} from './types'

type JsonRecord = Record<string, unknown>

const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SHAPES = new Set<InknoteShapeKind>(['line', 'rect', 'ellipse', 'arrow', 'square', 'circle', 'polygon', 'curve'])
const PEN_STYLES = new Set(['normal', 'pencil', 'brush', 'dashed', 'dotted'])
const TOOLS = new Set(['pen', 'ballpen', 'highlighter'])
const ALIGNS = new Set(['left', 'center', 'right'])

export type PageParseFailure = 'too_large' | 'invalid_json' | 'invalid_shape'

export interface ParsedPage {
  ok: true
  content: InknotePageContent
  dropped: number
  bytes: number
}
export interface RejectedPage {
  ok: false
  reason: PageParseFailure
}
export type PageParseResult = ParsedPage | RejectedPage

export interface ParsedSave {
  content: InknotePageContent
  assetIds: string[]
  dropped: number
  bytes: number
}

export interface LegacyPendingAsset {
  /** `images.0.src` or `bg.src`; the importer uploads it and writes the asset back. */
  path: string
  dataUrl: string
}

export interface LegacyPage {
  content: InknotePageContent
  pendingAssets: LegacyPendingAsset[]
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function own(row: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function emptyPageContent(): InknotePageContent {
  return { format: INKNOTE_PAGE_FORMAT, version: INKNOTE_PAGE_VERSION, strokes: [], texts: [], images: [], bg: null }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function serializePageContent(content: InknotePageContent): string {
  return JSON.stringify({
    format: INKNOTE_PAGE_FORMAT,
    version: INKNOTE_PAGE_VERSION,
    strokes: content.strokes,
    texts: content.texts,
    images: content.images,
    bg: content.bg,
  })
}

export function pageContentBytes(content: InknotePageContent): number {
  return utf8Bytes(serializePageContent(content))
}

function assetRef(value: unknown): { assetId: string; url: string } | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith(INKNOTE_ASSET_URL_PREFIX)) return null
  const assetId = value.slice(INKNOTE_ASSET_URL_PREFIX.length)
  if (!INKNOTE_ASSET_ID_RE.test(assetId)) return null
  return { assetId, url: value }
}

function parsePoint(value: unknown): InknotePoint | null {
  const row = record(value)
  if (!row) return null
  const x = own(row, 'x')
  const y = own(row, 'y')
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1e6) return null
  if (typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > 1e6) return null
  return { x, y, p: finite(own(row, 'p'), 1, 0.15, 1) }
}

function parseStroke(value: unknown): InknoteStroke | null {
  const row = record(value)
  if (!row) return null
  const id = own(row, 'id')
  const tool = own(row, 'tool')
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id) || typeof tool !== 'string' || !TOOLS.has(tool)) return null
  const color = normalizeInknoteColor(own(row, 'color'))
  if (!color) return null
  const rawPoints = array(own(row, 'points'))
  if (!rawPoints.length || rawPoints.length > INKNOTE_LIMITS.pointsPerStroke) return null
  const points: InknotePoint[] = []
  for (const raw of rawPoints) {
    const point = parsePoint(raw)
    if (point) points.push(point)
  }
  if (points.length < 1) return null
  const shapeValue = own(row, 'shape')
  const shape = typeof shapeValue === 'string' && SHAPES.has(shapeValue as InknoteShapeKind)
    ? shapeValue as InknoteShapeKind
    : null
  const styleValue = own(row, 'style')
  const style = typeof styleValue === 'string' && PEN_STYLES.has(styleValue)
    ? styleValue as InknoteStroke['style']
    : 'normal'
  return {
    id,
    tool: tool as InknoteStroke['tool'],
    style,
    shape,
    color,
    width: finite(own(row, 'width'), 4, 0.1, 100),
    points,
  }
}

function parseText(value: unknown): InknoteTextBox | null {
  const row = record(value)
  if (!row) return null
  const id = own(row, 'id')
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) return null
  const text = own(row, 'text')
  if (typeof text !== 'string' || text.length > INKNOTE_LIMITS.textLength) return null
  const color = normalizeInknoteColor(own(row, 'color'))
  if (!color) return null
  const hlRaw = own(row, 'hl')
  const hl = hlRaw === null || hlRaw === undefined ? null : normalizeInknoteColor(hlRaw)
  if (hlRaw !== null && hlRaw !== undefined && !hl) return null
  const listRaw = own(row, 'list')
  const list = listRaw === 'bullet' || listRaw === 'number' ? listRaw : null
  const alignRaw = own(row, 'align')
  return {
    id,
    x: finite(own(row, 'x'), 0, -2, 3),
    y: finite(own(row, 'y'), 0, -2, 3),
    w: finite(own(row, 'w'), 0.3, 0.001, 3),
    h: finite(own(row, 'h'), 0.06, 0.001, 3),
    text,
    fontSize: finite(own(row, 'fontSize'), 26, 6, 200),
    color,
    align: typeof alignRaw === 'string' && ALIGNS.has(alignRaw) ? alignRaw as InknoteTextBox['align'] : 'left',
    bold: bool(own(row, 'bold'), false),
    italic: bool(own(row, 'italic'), false),
    underline: bool(own(row, 'underline'), false),
    hl,
    lh: finite(own(row, 'lh'), 1.3, 0.8, 3),
    list,
  }
}

function parseImage(value: unknown): InknoteImage | null {
  const row = record(value)
  if (!row) return null
  const id = own(row, 'id')
  if (typeof id !== 'string' || !ITEM_ID_RE.test(id)) return null
  const ref = assetRef(own(row, 'url'))
  if (!ref) return null
  const rot = own(row, 'rot')
  return {
    id,
    x: finite(own(row, 'x'), 0.28, -2, 3),
    y: finite(own(row, 'y'), 0.25, -2, 3),
    w: finite(own(row, 'w'), 0.44, 0.001, 3),
    h: finite(own(row, 'h'), 0.3, 0.001, 3),
    assetId: ref.assetId,
    url: ref.url,
    rot: rot === 90 || rot === 180 || rot === 270 ? rot : 0,
  }
}

function parseBackground(value: unknown): InknotePageBackground | null | undefined {
  if (value === null || value === undefined) return null
  const row = record(value)
  if (!row) return undefined
  const ref = assetRef(own(row, 'url'))
  if (!ref) return undefined
  return {
    kind: own(row, 'kind') === 'pdf' ? 'pdf' : 'image',
    assetId: ref.assetId,
    url: ref.url,
    width: finite(own(row, 'width'), 816, 1, 4000),
    height: finite(own(row, 'height'), 1056, 1, 4000),
    alpha: finite(own(row, 'alpha'), 1, 0.1, 1),
  }
}

export function parseInknotePageContent(raw: unknown): PageParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_shape' }
  const bytes = utf8Bytes(raw)
  if (bytes > INKNOTE_LIMITS.pageContentMaxBytes) return { ok: false, reason: 'too_large' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  const row = record(value)
  if (!row || own(row, 'format') !== INKNOTE_PAGE_FORMAT || own(row, 'version') !== INKNOTE_PAGE_VERSION) {
    return { ok: false, reason: 'invalid_shape' }
  }
  const rawStrokes = own(row, 'strokes')
  const rawTexts = own(row, 'texts')
  const rawImages = own(row, 'images')
  if (!Array.isArray(rawStrokes) || !Array.isArray(rawTexts) || !Array.isArray(rawImages)) {
    return { ok: false, reason: 'invalid_shape' }
  }
  if (rawStrokes.length > INKNOTE_LIMITS.strokesPerPage
    || rawTexts.length > INKNOTE_LIMITS.textsPerPage
    || rawImages.length > INKNOTE_LIMITS.imagesPerPage) {
    return { ok: false, reason: 'too_large' }
  }
  const strokes: InknoteStroke[] = []
  const texts: InknoteTextBox[] = []
  const images: InknoteImage[] = []
  let dropped = 0
  let points = 0
  for (const entry of rawStrokes) {
    const stroke = parseStroke(entry)
    if (!stroke) { dropped++; continue }
    points += stroke.points.length
    if (points > INKNOTE_LIMITS.pointsPerPage) return { ok: false, reason: 'too_large' }
    strokes.push(stroke)
  }
  for (const entry of rawTexts) {
    const text = parseText(entry)
    if (text) texts.push(text)
    else dropped++
  }
  for (const entry of rawImages) {
    const image = parseImage(entry)
    if (image) images.push(image)
    else dropped++
  }
  const bg = parseBackground(own(row, 'bg'))
  if (bg === undefined) { dropped++; }
  return {
    ok: true,
    content: {
      format: INKNOTE_PAGE_FORMAT,
      version: INKNOTE_PAGE_VERSION,
      strokes,
      texts,
      images,
      bg: bg ?? null,
    },
    dropped,
    bytes,
  }
}

export function sanitizePageForSave(raw: unknown): { ok: true; result: ParsedSave } | { ok: false; reason: PageParseFailure } {
  const parsed = parseInknotePageContent(raw)
  if (!parsed.ok) return parsed
  const assetIds = new Set<string>()
  for (const image of parsed.content.images) assetIds.add(image.assetId)
  if (parsed.content.bg) assetIds.add(parsed.content.bg.assetId)
  return {
    ok: true,
    result: {
      content: parsed.content,
      assetIds: [...assetIds],
      dropped: parsed.dropped,
      bytes: parsed.bytes,
    },
  }
}

export function extractPageText(content: InknotePageContent): string {
  const parts: string[] = []
  for (const item of content.texts) {
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (text) parts.push(text)
    if (parts.join('\n').length >= 200_000) break
  }
  return parts.join('\n').slice(0, 200_000)
}

export interface Note2Envelope {
  kind: 'note' | 'library'
  notes: unknown[]
  library: unknown | null
}

export function parseNote2Envelope(raw: unknown): Note2Envelope | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return null }
  }
  const row = record(value)
  if (!row || own(row, 'format') !== 'note2' || own(row, 'version') !== 1) return null
  const type = own(row, 'type')
  if (type === 'note') {
    const note = own(row, 'note')
    return record(note) ? { kind: 'note', notes: [note], library: null } : null
  }
  if (type === 'library') {
    const library = record(own(row, 'library'))
    const notes = library ? record(own(library, 'notes')) : null
    if (!library || !notes) return null
    return { kind: 'library', notes: Object.values(notes), library }
  }
  return null
}

function legacyId(value: unknown): string | null {
  return typeof value === 'string' && ITEM_ID_RE.test(value) ? value : null
}

function legacyAsset(value: unknown, path: string, pending: LegacyPendingAsset[]): { assetId: string; url: string } | null {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:image/')) {
    pending.push({ path, dataUrl: value })
    return { assetId: '', url: '' }
  }
  return assetRef(value)
}

/** Maps one reference page (storage.js sanitizePage shape) into the internal envelope. */
export function normalizeLegacyPage(raw: unknown): LegacyPage | null {
  const row = record(raw)
  if (!row) return null
  const pending: LegacyPendingAsset[] = []
  const strokes: InknoteStroke[] = []
  const texts: InknoteTextBox[] = []
  const images: InknoteImage[] = []
  for (const [index, entry] of array(own(row, 'strokes')).entries()) {
    const item = record(entry)
    if (!item) continue
    const id = legacyId(own(item, 'id')) ?? `legacy-s-${index}`
    const tool = own(item, 'tool') === 'highlighter' ? 'highlighter' : 'pen'
    const color = normalizeInknoteColor(own(item, 'color')) ?? '#1e293b'
    const points = array(own(item, 'points')).flatMap((point) => {
      const parsed = parsePoint(point)
      return parsed ? [parsed] : []
    })
    if (!points.length) continue
    const shapeValue = own(item, 'shape')
    strokes.push({
      id,
      tool,
      style: typeof own(item, 'style') === 'string' && PEN_STYLES.has(own(item, 'style') as string)
        ? own(item, 'style') as InknoteStroke['style']
        : 'normal',
      shape: typeof shapeValue === 'string' && SHAPES.has(shapeValue as InknoteShapeKind) ? shapeValue as InknoteShapeKind : null,
      color,
      width: finite(own(item, 'width'), 4, 0.1, 100),
      points,
    })
  }
  for (const [index, entry] of array(own(row, 'texts')).entries()) {
    const parsed = parseText({ ...(record(entry) ?? {}), id: legacyId(own(record(entry) ?? {}, 'id')) ?? `legacy-t-${index}` })
    if (parsed) texts.push(parsed)
  }
  for (const [index, entry] of array(own(row, 'images')).entries()) {
    const item = record(entry)
    if (!item) continue
    const ref = legacyAsset(own(item, 'src'), `images.${index}.src`, pending)
    if (!ref) continue
    const rot = own(item, 'rot')
    images.push({
      id: legacyId(own(item, 'id')) ?? `legacy-i-${index}`,
      x: finite(own(item, 'x'), 0.28, -2, 3),
      y: finite(own(item, 'y'), 0.25, -2, 3),
      w: finite(own(item, 'w'), 0.44, 0.001, 3),
      h: finite(own(item, 'h'), 0.3, 0.001, 3),
      assetId: ref.assetId,
      url: ref.url,
      rot: rot === 90 || rot === 180 || rot === 270 ? rot : 0,
    })
  }
  const bgRow = record(own(row, 'bg'))
  let bg: InknotePageBackground | null = null
  if (bgRow) {
    const ref = legacyAsset(own(bgRow, 'src'), 'bg.src', pending)
    if (ref) {
      bg = {
        kind: own(bgRow, 'kind') === 'pdf' ? 'pdf' : 'image',
        assetId: ref.assetId,
        url: ref.url,
        width: finite(own(bgRow, 'w'), 816, 1, 4000),
        height: finite(own(bgRow, 'h'), 1056, 1, 4000),
        alpha: finite(own(bgRow, 'alpha'), 1, 0.1, 1),
      }
    }
  }
  return {
    content: { format: INKNOTE_PAGE_FORMAT, version: INKNOTE_PAGE_VERSION, strokes, texts, images, bg },
    pendingAssets: pending,
  }
}
