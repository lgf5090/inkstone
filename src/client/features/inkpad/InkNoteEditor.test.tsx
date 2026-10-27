import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { createEmptyInkDocument } from '../../lib/inkpad/document'
import { useInkSettingsStore } from './ink-settings-store'
import { InkNoteEditor } from './InkNoteEditor'

function contextStub(): CanvasRenderingContext2D {
    const noop = () => {}
    return {
        save: noop, restore: noop, beginPath: noop, closePath: noop,
        moveTo: noop, lineTo: noop, quadraticCurveTo: noop, arc: noop, ellipse: noop,
        fill: noop, stroke: noop, strokeRect: noop, fillRect: noop, clearRect: noop,
        drawImage: noop, setTransform: noop, translate: noop, scale: noop, setLineDash: noop,
        getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
        lineCap: 'round', lineJoin: 'round', globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    } as unknown as CanvasRenderingContext2D
}

function note(title = 'Sketch.ink'): NoteSummary {
    return { id: 'n1', title, folderId: null, isStarred: false, isArchived: false, deletedAt: null } as NoteSummary
}

let getContext: typeof HTMLCanvasElement.prototype.getContext
let observer: typeof ResizeObserver | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
    await initI18n()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function () { return contextStub() } as unknown as typeof getContext
    observer = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
        observe(): void {}
        disconnect(): void {}
    } as unknown as typeof ResizeObserver
    useInkSettingsStore.getState().resetSettings()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})

afterEach(() => {
    act(() => root.unmount())
    container.remove()
    HTMLCanvasElement.prototype.getContext = getContext
    if (observer) globalThis.ResizeObserver = observer
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    vi.unstubAllGlobals()
})

function render(content: string) {
    act(() => {
        root.render(createElement(InkNoteEditor, {
            note: note(),
            content,
            onChange: () => {},
            onTitleChange: () => {},
        }))
    })
}

describe('InkNoteEditor', () => {
    it('opens a broken body in the source view without mounting the toolbar', () => {
        render('not json')
        expect(container.querySelector('textarea')).not.toBeNull()
        expect(container.textContent).toContain('This .ink file could not be read')
        expect(container.querySelector('[aria-label="Pen"]')).toBeNull()
    })

    it('mounts the canvas and toolbar for a valid drawing', () => {
        render(createEmptyInkDocument())
        expect(container.querySelector('canvas')).not.toBeNull()
        expect(container.querySelector('[aria-label="Pen"]')).not.toBeNull()
        expect(container.textContent).toContain('Saved')
    })

    it('switches between the canvas source and back', () => {
        render(createEmptyInkDocument())
        act(() => {
            container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click()
        })
        expect(container.querySelector('textarea')).not.toBeNull()
        act(() => {
            container.querySelector<HTMLButtonElement>('[aria-label="Canvas"]')!.click()
        })
        expect(container.querySelector('canvas')).not.toBeNull()
    })
})
