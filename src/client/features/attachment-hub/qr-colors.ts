/**
 * A QR code is painted into an SVG the browser cannot restyle with a CSS variable, so its two colours
 * are absolute values rather than design tokens: a code that inverts with the theme stops scanning.
 */
export const QR_BG_COLOR = '#ffffff'
export const QR_FG_COLOR = '#0f172a'
