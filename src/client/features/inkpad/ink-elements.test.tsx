import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import type { InkElement } from '../../lib/inkpad/types'
import { useNotes } from '../../store/notes'
import type { InkEngine } from './ink-engine-types'
import { InkElements } from './ink-elements'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function fakeEngine(elements: InkElement[]) {
    return {
        elements: () => elements,
        layoutElements: vi.fn(),
        patchElement: vi.fn(),
        removeElement: vi.fn(),
        toggleElementLock: vi.fn(),
        bringElementToFront: vi.fn(),
        sendElementToBack: vi.fn(),
        startElementGesture: vi.fn(),
        moveElementBy: vi.fn(),
        resizeElementBy: vi.fn(),
    } as unknown as InkEngine
}

function render(engine: InkEngine, onOpenNote = vi.fn()) {
    act(() => {
        root.render(createElement(InkElements, { engine, version: 1, onOpenNote }))
    })
    return onOpenNote
}

function textElement(overrides: Partial<InkElement> = {}): InkElement {
    return { id: 't', kind: 'text', path: '', text: 'Hello card', x: 0, y: 0, width: 320, height: 100, ...overrides }
}

beforeEach(async () => {
    await initI18n()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useNotes.setState({ notes: {}, contents: {} })
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

describe('InkElements', () => {
    it('draws a body and a control layer for every card', () => {
        render(fakeEngine([textElement()]))
        expect(container.querySelector('[data-element-body-id="t"]')?.textContent).toContain('Hello card')
        expect(container.querySelector('[data-element-control-id="t"]')).not.toBeNull()
        expect(container.querySelector('[aria-label="Edit text"]')).not.toBeNull()
        expect(container.querySelector('[aria-label="Bring to front"]')).toBeNull()
    })

    it('opens a Markdown note card and renders its sanitized body', async () => {
        useNotes.setState({
            notes: {
                n1: { id: 'n1', title: 'Topic', deletedAt: null, isArchived: false } as never,
            },
            contents: { n1: '# Heading\n\n<script>alert(1)</script>' },
        })
        const onOpenNote = render(fakeEngine([{
            id: 'n', kind: 'markdown', path: 'Topic', noteId: 'n1', x: 0, y: 0, width: 440, height: 360,
        }]))
        await act(async () => {})
        const body = container.querySelector('[data-element-body-id="n"]')!
        expect(body.textContent).toContain('Heading')
        expect(body.innerHTML).not.toContain('<script')
        act(() => {
            container.querySelector<HTMLButtonElement>('[aria-label="Open note"]')!.click()
        })
        expect(onOpenNote).toHaveBeenCalledWith('n1')
    })

    it('does not render JSON for a typed note card', async () => {
        useNotes.setState({
            notes: { n1: { id: 'n1', title: 'Sketch.ink', deletedAt: null, isArchived: false } as never },
            contents: { n1: '{"format":"inkpad"}' },
        })
        render(fakeEngine([{ id: 'n', kind: 'markdown', path: 'Sketch.ink', noteId: 'n1', x: 0, y: 0, width: 440, height: 360 }]))
        await act(async () => {})
        expect(container.querySelector('[data-element-body-id="n"]')?.textContent).toContain('Open this file to view it.')
    })

    it('shows a missing state for a deleted note', async () => {
        useNotes.setState({
            notes: { n1: { id: 'n1', title: 'Gone', deletedAt: 1, isArchived: false } as never },
            contents: { n1: 'text' },
        })
        render(fakeEngine([{ id: 'n', kind: 'markdown', path: 'Gone', noteId: 'n1', x: 0, y: 0, width: 440, height: 360 }]))
        await act(async () => {})
        expect(container.querySelector('[data-element-body-id="n"]')?.textContent).toContain('This note is in the trash.')
    })

    it('writes the intrinsic image ratio back once', () => {
        const engine = fakeEngine([{ id: 'i', kind: 'image', path: 'x.png', url: '/api/files/x', x: 0, y: 0, width: 480, height: 360 }])
        render(engine)
        const image = container.querySelector<HTMLImageElement>('img')!
        Object.defineProperty(image, 'naturalWidth', { value: 800 })
        Object.defineProperty(image, 'naturalHeight', { value: 400 })
        act(() => image.dispatchEvent(new Event('load')))
        expect(engine.patchElement).toHaveBeenCalledWith('i', { aspectRatio: 2, height: 240 })
    })

    it('puts an audio control above the ink and keeps the body empty', () => {
        render(fakeEngine([{ id: 'a', kind: 'audio', path: 'voice.mp3', url: '/api/files/a', x: 0, y: 0, width: 440, height: 100 }]))
        const audio = container.querySelector<HTMLAudioElement>('audio')!
        expect(audio.getAttribute('src')).toBe('/api/files/a')
        expect(audio.hasAttribute('controls')).toBe(true)
        expect(container.querySelector('[data-element-body-id="a"]')?.textContent).toBe('')
    })

    it('shows a missing state when an image has no same-origin URL', () => {
        render(fakeEngine([{ id: 'i', kind: 'image', path: 'x.png', url: 'https://evil.example/x', x: 0, y: 0, width: 480, height: 360 }]))
        expect(container.querySelector('[data-element-body-id="i"]')?.textContent).toContain('File not found')
    })
})
