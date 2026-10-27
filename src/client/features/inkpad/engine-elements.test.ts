import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InkDocument } from '../../lib/inkpad/types'
import { InkEngineImpl } from './ink-engine'

function document(): InkDocument {
    return {
        format: 'inkpad',
        version: 1,
        strokes: [],
        shapes: [],
        elements: [],
        viewport: { x: 10, y: 20, zoom: 2 },
    }
}

function host() {
    return {
        settings: vi.fn(() => ({ paperStyle: 'grid' as const, pressureResponse: 'subtle' as const })),
        onDirty: vi.fn(),
        onViewportChange: vi.fn(),
        onToolChange: vi.fn(),
        onSelectionChange: vi.fn(),
        onElementsChange: vi.fn(),
        onQuickMenu: vi.fn(),
        onError: vi.fn(),
        openNote: vi.fn(),
        openUrl: vi.fn(),
    }
}

describe('element document methods', () => {
    let engine: InkEngineImpl
    let callbacks: ReturnType<typeof host>

    beforeEach(() => {
        callbacks = host()
        engine = new InkEngineImpl(callbacks)
        engine.load(document())
    })

    it('inserts a note card at the viewport centre', () => {
        engine.insertNote({ id: 'note-1', title: 'Topic' })
        const element = engine.elements()[0]!
        expect(element).toMatchObject({ kind: 'markdown', noteId: 'note-1', path: 'Topic', width: 440, height: 360 })
        expect(callbacks.onDirty).toHaveBeenCalledTimes(1)
    })

    it('maps attachments by MIME and always keeps a same-origin URL', () => {
        engine.insertFile({ id: 'file-1', filename: 'deck.pdf', mime: 'application/pdf', url: 'https://evil.example/x' })
        expect(engine.elements()[0]).toMatchObject({
            kind: 'pdf',
            fileId: 'file-1',
            url: '/api/files/file-1',
            width: 560,
            height: 720,
        })
        engine.insertFile({ id: 'file-2', filename: 'archive.zip', mime: 'application/zip', url: '/api/files/file-2' })
        expect(callbacks.onError).toHaveBeenCalledWith('unsupported_file')
    })

    it('inserts trimmed text and ignores an empty card', () => {
        engine.insertText('  hello  ')
        engine.insertText('   ')
        expect(engine.elements()).toHaveLength(1)
        expect(engine.elements()[0]).toMatchObject({ kind: 'text', text: 'hello', path: '' })
    })

    it('patches text with one undo step and skips no-op patches', () => {
        engine.insertText('one')
        const id = engine.elements()[0]!.id
        const before = callbacks.onElementsChange.mock.calls.length
        engine.patchElement(id, { text: 'one' })
        expect(callbacks.onElementsChange).toHaveBeenCalledTimes(before)
        engine.patchElement(id, { text: 'two' }, { history: true })
        expect(engine.elements()[0]!.text).toBe('two')
        engine.undo()
        expect(engine.elements()[0]!.text).toBe('one')
    })

    it('resizes images by their aspect ratio and turns PDF page height off', () => {
        engine.insertFile({ id: 'image', filename: 'x.png', mime: 'image/png', url: '/api/files/image' })
        const image = engine.elements()[0]!
        engine.resizeElementBy(image.id, 120, 0)
        expect(image.width).toBe(600)
        expect(image.height).toBeCloseTo(450)

        engine.insertFile({ id: 'pdf', filename: 'x.pdf', mime: 'application/pdf', url: '/api/files/pdf' })
        const pdf = engine.elements()[1]!
        pdf.fitPdfPages = true
        engine.resizeElementBy(pdf.id, 10, 10)
        expect(pdf.fitPdfPages).toBe(false)
        expect(pdf.width).toBeGreaterThanOrEqual(160)
        expect(pdf.height).toBeGreaterThanOrEqual(120)
    })

    it('locks movement and can reorder cards', () => {
        engine.insertText('a')
        engine.insertText('b')
        const [first, second] = engine.elements()
        engine.toggleElementLock(first!.id)
        engine.moveElementBy(first!.id, 50, 50)
        const x = first!.x
        engine.moveElementBy(first!.id, 50, 50)
        expect(first!.x).toBe(x)
        engine.bringElementToFront(first!.id)
        expect(engine.elements()[1]!.id).toBe(first!.id)
        engine.sendElementToBack(first!.id)
        expect(engine.elements()[0]!.id).toBe(first!.id)
        expect(second).toBeDefined()
    })

    it('serializes the current viewport', () => {
        const parsed = JSON.parse(engine.serialize()) as InkDocument
        expect(parsed.viewport).toEqual({ x: 10, y: 20, zoom: 2 })
    })
})

describe('inkless export', () => {
    it('returns no SVG or selection PNG without ink', async () => {
        const engine = new InkEngineImpl(host())
        engine.load(document())
        expect(engine.exportSvgString()).toBeNull()
        expect(await engine.exportPngBlob()).toBeNull()
        expect(await engine.exportSelectionPngBlob()).toBeNull()
    })

    it('exports an SVG once a stroke exists', () => {
        const engine = new InkEngineImpl(host())
        engine.load({
            ...document(),
            strokes: [{ id: 's', tool: 'pen', color: '#fff', width: 2, points: [{ x: 0, y: 0, p: 0.5, t: 0 }, { x: 5, y: 5, p: 0.5, t: 1 }] }],
        })
        expect(engine.exportSvgString()).toContain('<svg')
    })
})
