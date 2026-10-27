import type { InkPoint, InkTool } from './types'

export type InkPressureResponse = 'fixed' | 'subtle' | 'natural'

export interface InkPath {
    moveTo(x: number, y: number): void
    lineTo(x: number, y: number): void
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
}

const PENCIL_WIDTH = 0.82
const MARKER_WIDTH = 1.7
const HIGHLIGHTER_WIDTH = 4

export function strokeBaseWidth(tool: InkTool, width: number): number {
    if (tool === 'highlighter') return width * HIGHLIGHTER_WIDTH
    if (tool === 'marker') return width * MARKER_WIDTH
    if (tool === 'pencil') return width * PENCIL_WIDTH
    return width
}

/**
 * The reference implementation computes one width for the active stroke from its latest sample.
 * Pressure is intentionally not turned into per-segment variable width: that would be a different
 * renderer with different cost, not a port of this one.
 */
export function strokeWidthAt(tool: InkTool, width: number, pressure: number, response: InkPressureResponse): number {
    const base = strokeBaseWidth(tool, width)
    if (response === 'fixed') return base
    const p = Math.min(0.9, Math.max(0.2, pressure))
    if (response === 'natural') return base * (tool === 'pencil' ? 0.55 + p * 0.45 : 0.62 + p * 0.38)
    return base * (tool === 'pencil' ? 0.72 + p * 0.28 : 0.86 + p * 0.14)
}

export function strokeAlpha(tool: InkTool): number {
    if (tool === 'highlighter') return 0.32
    if (tool === 'pencil') return 0.78
    return 1
}

/** Raw pointer pressure is noisy even for a steady hand; this is the reference low-pass. */
export function filterPressure(previous: number | undefined, raw: number): number {
    const target = Math.min(0.9, Math.max(0.2, Number.isFinite(raw) ? raw : 0.5))
    if (previous === undefined) return target
    return previous + (target - previous) * 0.18
}

export function canAcceptPoint(last: InkPoint | undefined, next: Pick<InkPoint, 'x' | 'y'>, zoom: number): boolean {
    if (!last) return true
    return Math.hypot(next.x - last.x, next.y - last.y) > 0.15 / zoom
}

/** Midpoint quadratics: one Canvas path per browser packet, with no angular corners left. */
export function traceSmoothPath(context: InkPath, points: readonly InkPoint[]): void {
    if (!points.length) return
    context.moveTo(points[0]!.x, points[0]!.y)
    if (points.length === 2) {
        context.lineTo(points[1]!.x, points[1]!.y)
        return
    }
    for (let index = 1; index < points.length - 1; index++) {
        const control = points[index]!
        const next = points[index + 1]!
        context.quadraticCurveTo(control.x, control.y, (control.x + next.x) / 2, (control.y + next.y) / 2)
    }
    const last = points[points.length - 1]!
    context.lineTo(last.x, last.y)
}

export function strokeSvgPath(points: readonly InkPoint[]): string {
    if (!points.length) return ''
    let path = `M ${points[0]!.x} ${points[0]!.y}`
    for (let index = 1; index < points.length - 1; index++) {
        const control = points[index]!
        const next = points[index + 1]!
        path += ` Q ${control.x} ${control.y} ${(control.x + next.x) / 2} ${(control.y + next.y) / 2}`
    }
    if (points.length > 1) {
        const last = points[points.length - 1]!
        path += ` L ${last.x} ${last.y}`
    }
    return path
}
