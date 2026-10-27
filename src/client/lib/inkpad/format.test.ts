import { describe, expect, it } from 'vitest'
import { extractAttachmentIds } from '@shared/markdown-utils'
import {
    INK_BODY_LIMIT_BYTES,
    inkBodyBytes,
    isInkpadDocument,
    parseInkDocument,
    parseInkDocumentResult,
    serializeInkDocument,
} from './format'
import type { InkDocument } from './types'

const FILE_ID = 'a'.repeat(26)

function document(overrides: Partial<InkDocument> = {}): InkDocument {
    return {
        format: 'inkpad',
        version: 1,
        strokes: [],
        shapes: [],
        elements: [],
        ...overrides,
    }
}

describe('parseInkDocumentResult', () => {
    it('parses a stroke and its optional fields', () => {
        const result = parseInkDocumentResult(JSON.stringify(document({
            strokes: [{
                id: 's1', tool: 'pen', color: '#ffffff', width: 3, link: 'Topic',
                points: [{ x: 1, y: 2, p: 0.7, t: 5 }],
            }],
        })))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document.strokes[0]).toMatchObject({ id: 's1', tool: 'pen', color: '#ffffff', width: 3, link: 'Topic' })
        expect(result.document.strokes[0]!.points[0]).toEqual({ x: 1, y: 2, p: 0.7, t: 5 })
    })

    it('drops invalid items without failing the envelope', () => {
        const result = parseInkDocumentResult(JSON.stringify({
            format: 'inkpad',
            version: 1,
            strokes: [
                { id: 'bad-tool', tool: 'spray', color: '#000', width: 2, points: [{ x: 1, y: 2 }] },
                { id: 'bad-color', tool: 'pen', color: '"><script>', width: 2, points: [{ x: 1, y: 2 }] },
                { id: 'ok', tool: 'pencil', color: 'red', width: 2, points: [{ x: 1, y: 2 }] },
            ],
            shapes: [],
            elements: [],
        }))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document.strokes.map((stroke) => stroke.id)).toEqual(['ok'])
        expect(result.document.strokes[0]!.points[0]!.p).toBe(0.5)
        expect(result.document.strokes[0]!.points[0]!.t).toBe(0)
    })

    it('clamps widths, pressure, bookmarks and viewport', () => {
        const result = parseInkDocumentResult(JSON.stringify(document({
            strokes: [{ id: 's', tool: 'pen', color: '#000', width: 999, points: [{ x: 0, y: 0, p: 0, t: 0 }] }],
            bookmarks: [{ id: 'b', name: 'x'.repeat(100), x: 1, y: 2, zoom: 99 }],
            viewport: { x: 1, y: 2, zoom: 0.01 },
        })))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document.strokes[0]!.width).toBe(64)
        expect(result.document.strokes[0]!.points[0]!.p).toBe(0.2)
        expect(result.document.bookmarks![0]!.name).toHaveLength(80)
        expect(result.document.bookmarks![0]!.zoom).toBe(6)
        expect(result.document.viewport!.zoom).toBe(0.15)
    })

    it('keeps note/file references and the attachment URL', () => {
        const result = parseInkDocumentResult(JSON.stringify(document({
            elements: [
                { id: 'n', kind: 'markdown', path: 'Topic', noteId: 'note-1', x: 0, y: 0, width: 100, height: 100 },
                {
                    id: 'f', kind: 'pdf', path: 'deck.pdf', fileId: FILE_ID, mime: 'application/pdf',
                    url: `/api/files/${FILE_ID}`, x: 0, y: 0, width: 100, height: 100,
                },
            ],
        })))
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document.elements[0]!.noteId).toBe('note-1')
        expect(result.document.elements[1]!.fileId).toBe(FILE_ID)
        expect(serializeInkDocument(result.document)).toContain(`/api/files/${FILE_ID}`)
    })

    it('rejects an invalid envelope and a non-string body', () => {
        expect(parseInkDocumentResult('not json').ok).toBe(false)
        expect(parseInkDocumentResult('[]').ok).toBe(false)
        expect(parseInkDocumentResult(JSON.stringify({ format: 'inkpad', version: 2, strokes: [] })).ok).toBe(false)
        expect(parseInkDocumentResult(JSON.stringify({ format: 'other', version: 1, strokes: [] })).ok).toBe(false)
        expect(parseInkDocumentResult(undefined as unknown as string).ok).toBe(false)
    })

    it('refuses a body over the note ceiling before parsing it', () => {
        const result = parseInkDocumentResult('x'.repeat(INK_BODY_LIMIT_BYTES + 1))
        expect(result).toEqual({ ok: false, reason: 'too_large' })
    })

    it('does not pollute Object.prototype', () => {
        const raw = '{"format":"inkpad","version":1,"strokes":[],"__proto__":{"polluted":true}}'
        const result = parseInkDocumentResult(raw)
        expect(result.ok).toBe(true)
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
        const parsed = (result.ok ? result.document : {}) as { polluted?: boolean }
        expect(parsed.polluted).toBeUndefined()
    })

    it('returns an empty document from the compatibility wrapper', () => {
        expect(parseInkDocument('not json')).toEqual(document())
    })
})

describe('isInkpadDocument', () => {
    it('checks only the envelope', () => {
        expect(isInkpadDocument(JSON.stringify(document()))).toBe(true)
        expect(isInkpadDocument('not json')).toBe(false)
        expect(isInkpadDocument(JSON.stringify({ format: 'inkpad', version: 1 }))).toBe(false)
    })
})

describe('serialization', () => {
    it('round-trips the parsed document', () => {
        const parsed = parseInkDocument(JSON.stringify(document({
            shapes: [{ id: 'r', type: 'rectangle', color: '#fff', width: 2, start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }],
        })))
        expect(parseInkDocument(serializeInkDocument(parsed)).shapes[0]).toMatchObject({ id: 'r', type: 'rectangle' })
    })

    it('keeps an attachment reference visible to the pruning scan', () => {
        const doc = document({
            elements: [{
                id: 'f', kind: 'image', path: 'x.png', fileId: FILE_ID, mime: 'image/png',
                url: `/api/files/${FILE_ID}`, x: 0, y: 0, width: 100, height: 100,
            }],
        })
        expect(extractAttachmentIds(serializeInkDocument(doc))).toContain(FILE_ID)
    })

    it('counts UTF-8 bytes, not code units', () => {
        expect(inkBodyBytes('a')).toBe(1)
        expect(inkBodyBytes('中')).toBe(3)
    })
})
