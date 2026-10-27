import type { InkBounds } from '../../lib/inkpad/geometry'
import { inkBounds } from '../../lib/inkpad/geometry'
import type { InkPressureResponse } from '../../lib/inkpad/stroke-math'
import type { InkDocument } from '../../lib/inkpad/types'
import { paintShape, paintStroke } from './ink-renderer'

function hasInk(document: InkDocument): boolean {
    return document.strokes.length > 0 || document.shapes.length > 0
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(width))
    canvas.height = Math.max(1, Math.ceil(height))
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | null
    return context ? { canvas, context } : null
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

export async function renderInkPng(document: InkDocument, response: InkPressureResponse, scale = 2): Promise<Blob | null> {
    if (!hasInk(document)) return null
    const bounds = inkBounds(document, 24)
    const target = canvasOf(bounds.width * scale, bounds.height * scale)
    if (!target) return null
    target.context.scale(scale, scale)
    target.context.translate(-bounds.left, -bounds.top)
    for (const stroke of document.strokes) paintStroke(target.context, stroke, response)
    for (const shape of document.shapes) paintShape(target.context, shape)
    return toBlob(target.canvas)
}

export async function renderSelectionPng(
    document: InkDocument,
    bounds: InkBounds,
    strokeIds: ReadonlySet<string>,
    shapeIds: ReadonlySet<string>,
    response: InkPressureResponse,
    scale = 2,
    padding = 24,
): Promise<Blob | null> {
    const strokes = document.strokes.filter((stroke) => strokeIds.has(stroke.id))
    const shapes = document.shapes.filter((shape) => shapeIds.has(shape.id))
    if (!strokes.length && !shapes.length) return null
    const width = bounds.right - bounds.left + padding * 2
    const height = bounds.bottom - bounds.top + padding * 2
    const target = canvasOf(width * scale, height * scale)
    if (!target) return null
    target.context.scale(scale, scale)
    target.context.translate(-bounds.left + padding, -bounds.top + padding)
    for (const stroke of strokes) paintStroke(target.context, stroke, response)
    for (const shape of shapes) paintShape(target.context, shape)
    return toBlob(target.canvas)
}
