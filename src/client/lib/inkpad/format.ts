import { LIMITS } from '@shared/constants'
import { utf8ByteLength } from '@shared/text-utils'
import { isSafeInkColor } from './color'
import type {
    InkBookmark,
    InkDocument,
    InkElement,
    InkElementKind,
    InkPoint,
    InkShape,
    InkStroke,
    InkTool,
    InkViewport,
} from './types'

export const INK_BODY_LIMIT_BYTES = LIMITS.contentMaxBytes

const TOOLS: ReadonlySet<string> = new Set<InkTool>([
    'pen', 'pencil', 'marker', 'highlighter', 'eraser', 'lasso',
    'line', 'arrow', 'rectangle', 'ellipse',
])
const SHAPE_TYPES: ReadonlySet<string> = new Set<InkShape['type']>(['line', 'arrow', 'rectangle', 'ellipse'])
const ELEMENT_KINDS: ReadonlySet<string> = new Set<InkElementKind>(['markdown', 'pdf', 'image', 'audio', 'text'])
const MAX_LINK_LENGTH = 512
const MAX_ID_LENGTH = 200
const MAX_URL_LENGTH = 2048

export type InkParseResult =
    | { ok: true; document: InkDocument }
    | { ok: false; reason: 'invalid' | 'too_large' }

export function inkBodyBytes(content: string): number {
    return utf8ByteLength(content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamped(value: unknown, min: number, max: number, fallback: number): number {
    const number = finite(value)
    return number === null ? fallback : Math.min(max, Math.max(min, number))
}

function shortString(value: unknown, max: number): string | undefined {
    return typeof value === 'string' && value.length <= max ? value : undefined
}

function emptyDocument(): InkDocument {
    return { format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [] }
}

/** Checks the envelope before a view replaces its drawing with disk data. */
export function isInkpadDocument(raw: string): boolean {
    if (typeof raw !== 'string' || inkBodyBytes(raw) > INK_BODY_LIMIT_BYTES) return false
    try {
        const value: unknown = JSON.parse(raw)
        if (!isRecord(value)) return false
        return value.format === 'inkpad' && value.version === 1 && Array.isArray(value.strokes)
    } catch {
        return false
    }
}

function point(value: unknown): InkPoint | null {
    if (!isRecord(value)) return null
    const x = finite(value.x)
    const y = finite(value.y)
    if (x === null || y === null) return null
    return {
        x,
        y,
        p: clamped(value.p, 0.2, 0.9, 0.5),
        t: finite(value.t) ?? 0,
    }
}

function stroke(value: unknown): InkStroke | null {
    if (!isRecord(value)) return null
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) return null
    if (typeof value.tool !== 'string' || !TOOLS.has(value.tool)) return null
    if (!isSafeInkColor(value.color)) return null
    const width = finite(value.width)
    if (width === null || !Array.isArray(value.points)) return null
    const points = value.points.map(point).filter((item): item is InkPoint => item !== null)
    if (!points.length) return null
    return {
        id: value.id,
        tool: value.tool as InkTool,
        color: value.color.trim(),
        width: Math.min(64, Math.max(1, width)),
        points,
        link: shortString(value.link, MAX_LINK_LENGTH),
    }
}

function shape(value: unknown): InkShape | null {
    if (!isRecord(value)) return null
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) return null
    if (typeof value.type !== 'string' || !SHAPE_TYPES.has(value.type)) return null
    if (!isSafeInkColor(value.color)) return null
    const width = finite(value.width)
    if (width === null || !isRecord(value.start) || !isRecord(value.end)) return null
    const startX = finite(value.start.x)
    const startY = finite(value.start.y)
    const endX = finite(value.end.x)
    const endY = finite(value.end.y)
    if (startX === null || startY === null || endX === null || endY === null) return null
    return {
        id: value.id,
        type: value.type as InkShape['type'],
        color: value.color.trim(),
        width: Math.min(64, Math.max(1, width)),
        start: { x: startX, y: startY },
        end: { x: endX, y: endY },
        link: shortString(value.link, MAX_LINK_LENGTH),
    }
}

function element(value: unknown): InkElement | null {
    if (!isRecord(value)) return null
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) return null
    if (typeof value.path !== 'string') return null
    if (typeof value.kind !== 'string' || !ELEMENT_KINDS.has(value.kind)) return null
    const x = finite(value.x)
    const y = finite(value.y)
    const width = finite(value.width)
    const height = finite(value.height)
    if (x === null || y === null || width === null || height === null) return null
    const aspectRatio = finite(value.aspectRatio)
    const pageCount = finite(value.pageCount)
    const pageAspect = finite(value.pageAspect)
    return {
        id: value.id,
        kind: value.kind as InkElementKind,
        path: value.path,
        noteId: shortString(value.noteId, MAX_ID_LENGTH),
        fileId: shortString(value.fileId, MAX_ID_LENGTH),
        url: shortString(value.url, MAX_URL_LENGTH),
        mime: shortString(value.mime, 200),
        text: typeof value.text === 'string' ? value.text : undefined,
        x,
        y,
        width: Math.max(120, width),
        height: Math.max(100, height),
        aspectRatio: aspectRatio !== null ? Math.max(0.1, aspectRatio) : undefined,
        locked: value.locked === true,
        pageCount: pageCount !== null ? Math.max(1, Math.round(pageCount)) : undefined,
        pageAspect: pageAspect !== null ? Math.max(0.1, pageAspect) : undefined,
        fitPdfPages: value.fitPdfPages === true,
    }
}

function bookmark(value: unknown): InkBookmark | null {
    if (!isRecord(value)) return null
    if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH) return null
    if (typeof value.name !== 'string') return null
    const x = finite(value.x)
    const y = finite(value.y)
    const zoom = finite(value.zoom)
    if (x === null || y === null || zoom === null) return null
    return { id: value.id, name: value.name.slice(0, 80), x, y, zoom: Math.min(6, Math.max(0.15, zoom)) }
}

function viewport(value: unknown): InkViewport | undefined {
    if (!isRecord(value)) return undefined
    const x = finite(value.x)
    const y = finite(value.y)
    const zoom = finite(value.zoom)
    if (x === null || y === null || zoom === null) return undefined
    return { x, y, zoom: Math.min(6, Math.max(0.15, zoom)) }
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
    return Array.isArray(value) ? value.map(read).filter((item): item is T => item !== null) : []
}

/**
 * Parses only the portable, versioned document shape. Invalid items are dropped; an invalid
 * envelope fails whole, so a broken file is never replaced by a blank drawing.
 */
export function parseInkDocumentResult(raw: string): InkParseResult {
    if (typeof raw !== 'string' || inkBodyBytes(raw) > INK_BODY_LIMIT_BYTES) {
        return { ok: false, reason: 'too_large' }
    }
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return { ok: false, reason: 'invalid' }
    }
    if (!isRecord(value) || value.format !== 'inkpad' || value.version !== 1 || !Array.isArray(value.strokes)) {
        return { ok: false, reason: 'invalid' }
    }
    return {
        ok: true,
        document: {
            format: 'inkpad',
            version: 1,
            strokes: list(value.strokes, stroke),
            shapes: list(value.shapes, shape),
            elements: list(value.elements, element),
            bookmarks: Array.isArray(value.bookmarks) ? list(value.bookmarks, bookmark) : undefined,
            viewport: viewport(value.viewport),
        },
    }
}

export function parseInkDocument(raw: string): InkDocument {
    const result = parseInkDocumentResult(raw)
    return result.ok ? result.document : emptyDocument()
}

export function serializeInkDocument(document: InkDocument): string {
    return JSON.stringify(document)
}
