import { describe, expect, it } from 'vitest'
import type { InkShape, InkStroke } from '../../lib/inkpad/types'
import { inkCanvasBudget, paintShape, paintStroke } from './ink-renderer'

function recordingContext(): { context: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = []
    const context = {
        calls,
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        beginPath: () => calls.push('beginPath'),
        arc: (x: number, y: number, r: number) => calls.push(`arc ${x} ${y} ${r}`),
        fill: () => calls.push('fill'),
        stroke: () => calls.push('stroke'),
        moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
        lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
        quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => calls.push(`quadraticCurveTo ${cx} ${cy} ${x} ${y}`),
        strokeRect: () => calls.push('strokeRect'),
        ellipse: () => calls.push('ellipse'),
    } as unknown as CanvasRenderingContext2D
    return { context, calls }
}

function stroke(points: InkStroke['points']): InkStroke {
    return { id: 's', tool: 'pen', color: '#fff', width: 4, points }
}

describe('inkCanvasBudget', () => {
    it('uses the device ratio for ordinary viewports', () => {
        expect(inkCanvasBudget(800, 600, 2, false)).toEqual({ pixelRatio: 2, cachePixelRatio: 2 })
    })

    it('bounds a 4K viewport at a lower ratio', () => {
        const budget = inkCanvasBudget(3840, 2160, 2.5, false)
        expect(budget.pixelRatio).toBeLessThan(2.5)
        expect(budget.pixelRatio * budget.pixelRatio * 3840 * 2160).toBeLessThanOrEqual(16_000_001)
    })

    it('gives Windows a 1× navigation bitmap and never divides by zero', () => {
        expect(inkCanvasBudget(1600, 1000, 2, true).cachePixelRatio).toBe(1)
        expect(inkCanvasBudget(0, 0, 0, false).pixelRatio).toBe(1)
    })
})

describe('painting', () => {
    it('paints a single point as a round dot', () => {
        const { context, calls } = recordingContext()
        paintStroke(context, stroke([{ x: 5, y: 6, p: 0.5, t: 0 }]), 'fixed')
        expect(calls).toContain('arc 5 6 2')
        expect(calls).toContain('fill')
    })

    it('paints a multi-point stroke as one smooth path', () => {
        const { context, calls } = recordingContext()
        paintStroke(context, stroke([{ x: 0, y: 0, p: 0.5, t: 0 }, { x: 1, y: 1, p: 0.5, t: 0 }, { x: 2, y: 2, p: 0.5, t: 0 }]), 'subtle')
        expect(calls.filter((call) => call.startsWith('quadraticCurveTo'))).toHaveLength(1)
        expect(calls).toContain('stroke')
    })

    it('draws a rectangle, an ellipse, a line and an arrow head', () => {
        const rectangle: InkShape = { id: 'r', type: 'rectangle', color: '#000', width: 2, start: { x: 0, y: 0 }, end: { x: 4, y: 4 } }
        const ellipse: InkShape = { ...rectangle, id: 'e', type: 'ellipse' }
        const line: InkShape = { ...rectangle, id: 'l', type: 'line' }
        const arrow: InkShape = { ...rectangle, id: 'a', type: 'arrow' }
        const rectangleContext = recordingContext()
        paintShape(rectangleContext.context, rectangle)
        expect(rectangleContext.calls).toContain('strokeRect')
        const ellipseContext = recordingContext()
        paintShape(ellipseContext.context, ellipse)
        expect(ellipseContext.calls).toContain('ellipse')
        const lineContext = recordingContext()
        paintShape(lineContext.context, line)
        expect(lineContext.calls.filter((call) => call.startsWith('lineTo'))).toHaveLength(1)
        const arrowContext = recordingContext()
        paintShape(arrowContext.context, arrow)
        expect(arrowContext.calls.filter((call) => call.startsWith('lineTo'))).toHaveLength(3)
    })
})
