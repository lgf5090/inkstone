const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Settings only ever hold what the colour wheel produces, so the boot path needs no parser. */
export function isHexInkColor(value: unknown): value is string {
    return typeof value === 'string' && HEX_COLOR.test(value)
}
