import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InkDocument } from '../../lib/inkpad/types'
import { InkEngineImpl } from './ink-engine'

function contextStub(): CanvasRenderingContext2D {
    const noop = () => {}
    return {
        save: noop, restore: noop, beginPath: noop, closePath: noop,
        moveTo: noop, lineTo: noop, quadraticCurveTo: noop, arc: noop, ellipse: noop,
        fill: noop, stroke: noop, strokeRect: noop, fillRect: noop, clearRect: noop,
        drawImage: noop, setTransform: noop, translate: noop, scale: noop, setLineDash: noop,
        lineCap: 'round', lineJoin: 'round', globalAlpha: 1, globalCompositeOperation: 'source-over',
        strokeStyle: '#000', fillStyle: '#000', lineWidth: 1,
    } as unknown as CanvasRenderingContext2D
}

function pointerEvent(type: string, init: Record<string, unknown>): Event {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>
    Object.assign(event, {
        pointerId: 1, pointerType: 'pen', button: 0, buttons: 1,
        clientX: 0, clientY: 0, pressure: 0.5,
        ...init,
    })
    return event
}

function blank(): InkDocument {
    return { format: 'inkpad', version: 1, strokes: [], shapes: [], elements: [] }
}

describe('engine input pipeline', () => {
    let getContext: typeof HTMLCanvasElement.prototype.getContext
    let observer: typeof ResizeObserver | undefined

    beforeEach(() => {
        getContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function () { return contextStub() } as unknown as typeof getContext
        observer = globalThis.ResizeObserver
        globalThis.ResizeObserver = class {
            observe(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver
    })

    afterEach(() => {
        HTMLCanvasElement.prototype.getContext = getContext
        if (observer) globalThis.ResizeObserver = observer
        else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    })

    function mount() {
        const canvas = document.createElement('canvas')
        const hostEl = document.createElement('div')
        hostEl.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
        document.body.append(hostEl, canvas)
        const host = {
            settings: () => ({ paperStyle: 'grid' as const, pressureResponse: 'subtle' as const }),
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
        const engine = new InkEngineImpl(host)
        engine.mount(canvas, hostEl)
        engine.load(blank())
        return { canvas, engine, host }
    }

    it('draws a stroke from pointer packets and marks the document dirty', () => {
        const { canvas, engine, host } = mount()
        canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
        canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 120, clientY: 110 }))
        canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 120 }))
        const document = JSON.parse(engine.serialize()) as InkDocument
        expect(document.strokes).toHaveLength(1)
        expect(document.strokes[0]!.points.length).toBeGreaterThanOrEqual(2)
        expect(host.onDirty).toHaveBeenCalled()
        engine.destroy()
    })

    it('opens the quick menu for a pen barrel press without drawing', () => {
        const { canvas, engine, host } = mount()
        canvas.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'pen', button: 2, buttons: 2, clientX: 40, clientY: 50 }))
        expect(host.onQuickMenu).toHaveBeenCalledWith(40, 50)
        expect(JSON.parse(engine.serialize()).strokes).toHaveLength(0)
        engine.destroy()
    })

    it('zooms with the wheel around the pointer', () => {
        const { canvas, engine } = mount()
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 400, clientY: 300, bubbles: true, cancelable: true }))
        expect(engine.zoom()).toBeGreaterThan(1)
        engine.destroy()
    })

    it('pans with the middle mouse button', () => {
        const { canvas, engine } = mount()
        canvas.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse', button: 1, clientX: 100, clientY: 100 }))
        canvas.dispatchEvent(pointerEvent('pointermove', { pointerType: 'mouse', button: 1, buttons: 4, clientX: 160, clientY: 130 }))
        canvas.dispatchEvent(pointerEvent('pointerup', { pointerType: 'mouse', button: 1, buttons: 0, clientX: 160, clientY: 130 }))
        expect(JSON.parse(engine.serialize()).viewport).toMatchObject({ x: 60, y: 30 })
        engine.destroy()
    })

    it('removes every listener on destroy', () => {
        const { canvas, engine, host } = mount()
        engine.destroy()
        canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }))
        expect(host.onDirty).not.toHaveBeenCalled()
    })
})
