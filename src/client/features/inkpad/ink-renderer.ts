import type { InkBounds } from '../../lib/inkpad/geometry'
import { strokeAlpha, strokeWidthAt, traceSmoothPath, type InkPressureResponse } from '../../lib/inkpad/stroke-math'
import type { InkDocument, InkPaperStyle, InkPoint, InkShape, InkStroke } from '../../lib/inkpad/types'
import type { InkTransform } from '../../lib/inkpad/transform'

export interface InkEngineSettingsLike {
    paperStyle: InkPaperStyle
    pressureResponse: InkPressureResponse
}

export interface InkCanvasBudget {
    pixelRatio: number
    cachePixelRatio: number
}

interface InkRenderCache {
    canvas: HTMLCanvasElement
    width: number
    height: number
    padding: number
    pixelRatio: number
    transform: InkTransform
}

const MAX_CANVAS_PIXELS = 16_000_000
const MAX_DPR = 2.5

function positive(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * Both canvases are bounded. A 4K viewport at 2.5× is ~52M pixels (~208 MB), which a browser
 * tab should not reserve for one drawing; the cache is bounded separately because it carries
 * padding and a Windows device gets a 1× navigation bitmap.
 */
export function inkCanvasBudget(width: number, height: number, dpr: number, isWindows: boolean): InkCanvasBudget {
    const w = positive(width)
    const h = positive(height)
    const base = Math.min(MAX_DPR, Math.max(1, Number.isFinite(dpr) ? dpr : 1))
    const fitMain = Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
    const pixelRatio = Math.max(1, Math.min(base, fitMain))
    const padding = Math.max(180, Math.min(360, Math.round(Math.max(w, h) * 0.28)))
    const cacheArea = (w + padding * 2) * (h + padding * 2)
    const cacheBase = isWindows ? 1 : pixelRatio
    const cacheFit = Math.sqrt(MAX_CANVAS_PIXELS / cacheArea)
    const cachePixelRatio = Math.max(1, Math.min(cacheBase, cacheFit))
    return { pixelRatio, cachePixelRatio }
}

export function paintStroke(context: CanvasRenderingContext2D, stroke: InkStroke, response: InkPressureResponse): void {
    const points = stroke.points
    if (!points.length) return
    context.save()
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = strokeAlpha(stroke.tool)
    context.strokeStyle = stroke.color
    if (points.length === 1) {
        const point = points[0]!
        context.fillStyle = stroke.color
        context.beginPath()
        context.arc(point.x, point.y, strokeWidthAt(stroke.tool, stroke.width, point.p, response) / 2, 0, Math.PI * 2)
        context.fill()
        context.restore()
        return
    }
    const last = points[points.length - 1]!
    context.lineWidth = strokeWidthAt(stroke.tool, stroke.width, last.p, response)
    traceSmoothPath(context, points)
    context.stroke()
    context.restore()
}

export function paintShape(context: CanvasRenderingContext2D, shape: InkShape): void {
    const { start, end } = shape
    context.save()
    context.strokeStyle = shape.color
    context.lineWidth = shape.width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    if (shape.type === 'line' || shape.type === 'arrow') {
        context.beginPath()
        context.moveTo(start.x, start.y)
        context.lineTo(end.x, end.y)
        context.stroke()
        if (shape.type === 'arrow') {
            const angle = Math.atan2(end.y - start.y, end.x - start.x)
            const size = Math.max(10, shape.width * 4)
            context.beginPath()
            context.moveTo(end.x, end.y)
            context.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6))
            context.moveTo(end.x, end.y)
            context.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6))
            context.stroke()
        }
    } else if (shape.type === 'rectangle') {
        context.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y))
    } else {
        context.beginPath()
        context.ellipse(
            (start.x + end.x) / 2,
            (start.y + end.y) / 2,
            Math.abs(end.x - start.x) / 2,
            Math.abs(end.y - start.y) / 2,
            0,
            0,
            Math.PI * 2,
        )
        context.stroke()
    }
    context.restore()
}

export class InkRenderer {
    private readonly canvas: HTMLCanvasElement
    private readonly context: CanvasRenderingContext2D | null
    private width = 1
    private height = 1
    private pixelRatio = 1
    private cachePixelRatio = 1
    private cache: InkRenderCache | null = null
    private dirty = true

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas
        this.context = canvas.getContext('2d', { alpha: true, desynchronized: true }) as CanvasRenderingContext2D | null
    }

    get available(): boolean {
        return this.context !== null
    }

    logicalSize(): { width: number; height: number } {
        return { width: this.width, height: this.height }
    }

    resize(rect: { width: number; height: number }, isWindows: boolean): void {
        this.width = Math.max(1, rect.width)
        this.height = Math.max(1, rect.height)
        const budget = inkCanvasBudget(this.width, this.height, window.devicePixelRatio || 1, isWindows)
        this.pixelRatio = budget.pixelRatio
        this.cachePixelRatio = budget.cachePixelRatio
        this.canvas.width = Math.max(1, Math.floor(this.width * this.pixelRatio))
        this.canvas.height = Math.max(1, Math.floor(this.height * this.pixelRatio))
        this.canvas.style.width = `${this.width}px`
        this.canvas.style.height = `${this.height}px`
        this.context?.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
        this.invalidate()
    }

    invalidate(): void {
        this.dirty = true
    }

    destroy(): void {
        this.cache = null
        this.invalidate()
    }

    render(
        document: InkDocument,
        transform: InkTransform,
        settings: InkEngineSettingsLike,
        activeStroke: InkStroke | null,
        activeShape: InkShape | null,
        lasso: readonly InkPoint[],
        selection: InkBounds | null,
        direct = false,
    ): void {
        const context = this.context
        if (!context) return
        context.clearRect(0, 0, this.width, this.height)
        this.drawGrid(context, transform, settings.paperStyle)
        if (direct) {
            this.paintAll(context, document, transform, settings.pressureResponse)
        } else if (!this.drawCache(context, transform)) {
            this.rebuildCache(document, transform, settings.pressureResponse, activeStroke, activeShape)
        }
        this.drawActiveInk(context, transform, settings.pressureResponse, activeStroke, activeShape)
        this.drawLasso(context, transform, lasso)
        this.drawSelection(context, transform, selection)
    }

    commitInk(stroke: InkStroke | undefined, shape: InkShape | undefined, transform: InkTransform, response: InkPressureResponse): boolean {
        const cache = this.cache
        if (!cache || this.dirty
            || cache.transform.x !== transform.x
            || cache.transform.y !== transform.y
            || cache.transform.zoom !== transform.zoom) {
            return false
        }
        const cacheContext = cache.canvas.getContext('2d', { alpha: true, desynchronized: true }) as CanvasRenderingContext2D | null
        if (!cacheContext) return false
        cacheContext.setTransform(cache.pixelRatio, 0, 0, cache.pixelRatio, 0, 0)
        cacheContext.translate(cache.padding + cache.transform.x, cache.padding + cache.transform.y)
        cacheContext.scale(cache.transform.zoom, cache.transform.zoom)
        if (stroke) paintStroke(cacheContext, stroke, response)
        if (shape) paintShape(cacheContext, shape)
        return true
    }

    drawSegment(stroke: InkStroke, from: InkPoint, to: InkPoint, transform: InkTransform, response: InkPressureResponse): void {
        const context = this.context
        if (!context) return
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.globalCompositeOperation = 'source-over'
        context.globalAlpha = strokeAlpha(stroke.tool)
        context.strokeStyle = stroke.color
        context.lineWidth = strokeWidthAt(stroke.tool, stroke.width, to.p, response)
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(to.x, to.y)
        context.stroke()
        context.restore()
    }

    drawCoalescedSegment(stroke: InkStroke, first: InkPoint, points: readonly InkPoint[], transform: InkTransform, response: InkPressureResponse): void {
        const context = this.context
        const last = points[points.length - 1]
        if (!context || !last) return
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.globalCompositeOperation = 'source-over'
        context.globalAlpha = strokeAlpha(stroke.tool)
        context.strokeStyle = stroke.color
        context.lineWidth = strokeWidthAt(stroke.tool, stroke.width, last.p, response)
        traceSmoothPath(context, [first, ...points])
        context.stroke()
        context.restore()
    }

    private paintAll(
        context: CanvasRenderingContext2D,
        document: InkDocument,
        transform: InkTransform,
        response: InkPressureResponse,
    ): void {
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        for (const stroke of document.strokes) paintStroke(context, stroke, response)
        for (const shape of document.shapes) paintShape(context, shape)
        context.restore()
    }

    private drawActiveInk(
        context: CanvasRenderingContext2D,
        transform: InkTransform,
        response: InkPressureResponse,
        stroke: InkStroke | null,
        shape: InkShape | null,
    ): void {
        if (!stroke && !shape) return
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        if (stroke) paintStroke(context, stroke, response)
        if (shape) paintShape(context, shape)
        context.restore()
    }

    private drawCache(context: CanvasRenderingContext2D, transform: InkTransform): boolean {
        const cache = this.cache
        if (!cache || this.dirty || cache.width !== Math.ceil(this.width) || cache.height !== Math.ceil(this.height)) return false
        const scale = transform.zoom / cache.transform.zoom
        if (scale < 0.72 || scale > 1.38) return false
        const left = transform.x - scale * cache.transform.x - scale * cache.padding
        const top = transform.y - scale * cache.transform.y - scale * cache.padding
        const width = (cache.width + cache.padding * 2) * scale
        const height = (cache.height + cache.padding * 2) * scale
        if (left > 0 || top > 0 || left + width < this.width || top + height < this.height) return false
        context.drawImage(cache.canvas, left, top, width, height)
        return true
    }

    private rebuildCache(
        document: InkDocument,
        transform: InkTransform,
        response: InkPressureResponse,
        activeStroke: InkStroke | null,
        activeShape: InkShape | null,
    ): void {
        const width = Math.max(1, Math.ceil(this.width))
        const height = Math.max(1, Math.ceil(this.height))
        const padding = Math.max(180, Math.min(360, Math.round(Math.max(width, height) * 0.28)))
        const cacheCanvas = this.canvas.ownerDocument.createElement('canvas')
        cacheCanvas.width = Math.ceil((width + padding * 2) * this.cachePixelRatio)
        cacheCanvas.height = Math.ceil((height + padding * 2) * this.cachePixelRatio)
        const cacheContext = cacheCanvas.getContext('2d', { alpha: true, desynchronized: true }) as CanvasRenderingContext2D | null
        if (!cacheContext) {
            if (this.context) this.paintAll(this.context, document, transform, response)
            return
        }
        cacheContext.setTransform(this.cachePixelRatio, 0, 0, this.cachePixelRatio, 0, 0)
        cacheContext.translate(padding + transform.x, padding + transform.y)
        cacheContext.scale(transform.zoom, transform.zoom)
        for (const stroke of document.strokes) if (stroke !== activeStroke) paintStroke(cacheContext, stroke, response)
        for (const shape of document.shapes) if (shape !== activeShape) paintShape(cacheContext, shape)
        this.cache = { canvas: cacheCanvas, width, height, padding, pixelRatio: this.cachePixelRatio, transform: { ...transform } }
        this.dirty = false
        this.context?.drawImage(cacheCanvas, -padding, -padding, width + padding * 2, height + padding * 2)
    }

    private drawGrid(context: CanvasRenderingContext2D, transform: InkTransform, paper: InkPaperStyle): void {
        if (paper === 'blank') return
        const step = 40 * transform.zoom
        if (step < 14) return
        const offsetX = ((transform.x % step) + step) % step
        const offsetY = ((transform.y % step) + step) % step
        context.save()
        context.strokeStyle = 'rgba(127, 140, 160, 0.16)'
        context.fillStyle = 'rgba(127, 140, 160, 0.22)'
        context.lineWidth = 1
        context.beginPath()
        if (paper === 'dots') {
            for (let x = offsetX; x < this.width; x += step) {
                for (let y = offsetY; y < this.height; y += step) {
                    context.moveTo(x + 1, y)
                    context.arc(x, y, 1, 0, Math.PI * 2)
                }
            }
            context.fill()
        } else if (paper === 'weekly') {
            const column = 240 * transform.zoom
            const row = 190 * transform.zoom
            const weekOffsetX = ((transform.x % column) + column) % column
            const weekOffsetY = ((transform.y % row) + row) % row
            for (let x = weekOffsetX; x < this.width; x += column) {
                context.moveTo(x, 0)
                context.lineTo(x, this.height)
            }
            for (let y = weekOffsetY; y < this.height; y += row) {
                context.moveTo(0, y)
                context.lineTo(this.width, y)
            }
            context.stroke()
        } else if (paper === 'music') {
            const staff = 220 * transform.zoom
            const staffOffset = ((transform.y % staff) + staff) % staff
            for (let y = staffOffset; y < this.height; y += staff) {
                for (let line = 0; line < 5; line++) {
                    context.moveTo(0, y + line * step)
                    context.lineTo(this.width, y + line * step)
                }
            }
            context.stroke()
        } else {
            for (let x = offsetX; x < this.width && paper === 'grid'; x += step) {
                context.moveTo(x, 0)
                context.lineTo(x, this.height)
            }
            for (let y = offsetY; y < this.height; y += step) {
                context.moveTo(0, y)
                context.lineTo(this.width, y)
            }
            if (paper === 'cornell') {
                const margin = transform.x + 145 * transform.zoom
                context.moveTo(margin, 0)
                context.lineTo(margin, this.height)
            }
            context.stroke()
        }
        context.restore()
    }

    private drawLasso(context: CanvasRenderingContext2D, transform: InkTransform, lasso: readonly InkPoint[]): void {
        if (lasso.length < 2) return
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        context.strokeStyle = '#8b5cf6'
        context.lineWidth = 1.5 / transform.zoom
        context.setLineDash([5 / transform.zoom, 5 / transform.zoom])
        context.beginPath()
        context.moveTo(lasso[0]!.x, lasso[0]!.y)
        for (const point of lasso.slice(1)) context.lineTo(point.x, point.y)
        context.stroke()
        context.restore()
    }

    private drawSelection(context: CanvasRenderingContext2D, transform: InkTransform, bounds: InkBounds | null): void {
        if (!bounds) return
        context.save()
        context.translate(transform.x, transform.y)
        context.scale(transform.zoom, transform.zoom)
        context.strokeStyle = '#8b5cf6'
        context.lineWidth = 1.5 / transform.zoom
        context.setLineDash([6 / transform.zoom, 4 / transform.zoom])
        context.strokeRect(bounds.left - 8, bounds.top - 8, bounds.right - bounds.left + 16, bounds.bottom - bounds.top + 16)
        context.restore()
    }
}
