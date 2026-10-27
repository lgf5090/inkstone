import { inkColorForSvg } from './color'
import { inkBounds } from './geometry'
import { strokeAlpha, strokeSvgPath, strokeWidthAt, type InkPressureResponse } from './stroke-math'
import type { InkDocument, InkShape, InkStroke } from './types'

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
}

function number(value: number): string {
    return Number.isFinite(value) ? String(value) : '0'
}

function strokeMarkup(stroke: InkStroke, response: InkPressureResponse): string {
    const last = stroke.points[stroke.points.length - 1]!
    const width = strokeWidthAt(stroke.tool, stroke.width, last.p, response)
    return `<path d="${escapeXml(strokeSvgPath(stroke.points))}" fill="none" stroke="${escapeXml(inkColorForSvg(stroke.color))}" stroke-width="${number(width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${number(strokeAlpha(stroke.tool))}"/>`
}

function shapeMarkup(shape: InkShape): string {
    const color = escapeXml(inkColorForSvg(shape.color))
    const width = number(shape.width)
    const common = `fill="none" stroke="${color}" stroke-width="${width}"`
    if (shape.type === 'rectangle') {
        return `<rect x="${number(Math.min(shape.start.x, shape.end.x))}" y="${number(Math.min(shape.start.y, shape.end.y))}" width="${number(Math.abs(shape.end.x - shape.start.x))}" height="${number(Math.abs(shape.end.y - shape.start.y))}" ${common}/>`
    }
    if (shape.type === 'ellipse') {
        return `<ellipse cx="${number((shape.start.x + shape.end.x) / 2)}" cy="${number((shape.start.y + shape.end.y) / 2)}" rx="${number(Math.abs(shape.end.x - shape.start.x) / 2)}" ry="${number(Math.abs(shape.end.y - shape.start.y) / 2)}" ${common}/>`
    }
    const line = `<line x1="${number(shape.start.x)}" y1="${number(shape.start.y)}" x2="${number(shape.end.x)}" y2="${number(shape.end.y)}" ${common} stroke-linecap="round"/>`
    if (shape.type === 'line') return line
    const angle = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x)
    const size = Math.max(10, shape.width * 4)
    const head = (offset: number): string => {
        const x = shape.end.x - size * Math.cos(angle + offset)
        const y = shape.end.y - size * Math.sin(angle + offset)
        return `<line x1="${number(shape.end.x)}" y1="${number(shape.end.y)}" x2="${number(x)}" y2="${number(y)}" ${common} stroke-linecap="round"/>`
    }
    return `${line}${head(-Math.PI / 6)}${head(Math.PI / 6)}`
}

/**
 * The ink alone, as a portable SVG. Cards are draw-time DOM and stay out of the file, matching
 * the reference exporter; colours and paths are normalized/escaped before they reach an attribute.
 */
export function buildInkSvg(document: InkDocument, response: InkPressureResponse = 'subtle'): string {
    const bounds = inkBounds(document, 24)
    const strokes = document.strokes.map((stroke) => strokeMarkup(stroke, response)).join('')
    const shapes = document.shapes.map(shapeMarkup).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(bounds.left)} ${number(bounds.top)} ${number(bounds.width)} ${number(bounds.height)}">${strokes}${shapes}</svg>`
}
