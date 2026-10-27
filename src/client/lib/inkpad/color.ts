import tinycolor from 'tinycolor2'

const UNSAFE_COLOR_CHARS = /[\u0000-\u001f\u007f<>"']/
const MAX_COLOR_LENGTH = 64

/**
 * A colour that is safe to persist and later paste into an SVG attribute. Tinycolor rejects
 * unknown keywords; the character check keeps a value that parses but carries markup out of
 * the exporter's attribute string.
 */
export function isSafeInkColor(value: unknown): value is string {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_COLOR_LENGTH || UNSAFE_COLOR_CHARS.test(trimmed)) return false
    return tinycolor(trimmed).isValid()
}

/** The canonical form used by the SVG exporter; null when the value is not a safe colour. */
export function normalizeInkColor(value: unknown): string | null {
    if (!isSafeInkColor(value)) return null
    return tinycolor(value.trim()).toRgbString()
}

export function inkColorForSvg(value: unknown): string {
    return normalizeInkColor(value) ?? '#000000'
}
