import { LIMITS } from './constants'
import { truncateText } from './text-utils'
import type { MessageKey } from './locales/en-US'

export const ORGANIZER_COLOR_MESSAGE_KEYS = {
  '#dc2626': 'color.red',
  '#e11d48': 'color.rose',
  '#ea580c': 'color.orange',
  '#ca8a04': 'color.amber',
  '#65a30d': 'color.olive',
  '#059669': 'color.emerald',
  '#0d9488': 'color.teal',
  '#0891b2': 'color.cyan',
  '#2563eb': 'color.blue',
  '#4f46e5': 'color.indigo',
  '#9333ea': 'color.purple',
  '#c026d3': 'color.fuchsia',
  '#db2777': 'color.magenta',
  '#92400e': 'color.brown',
  '#78716c': 'color.stone',
  '#64748b': 'color.slate',
} as const satisfies Record<(typeof ORGANIZER_COLORS)[number], MessageKey>

export const ORGANIZER_COLORS = [
  '#dc2626',
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#65a30d',
  '#059669',
  '#0d9488',
  '#0891b2',
  '#2563eb',
  '#4f46e5',
  '#9333ea',
  '#c026d3',
  '#db2777',
  '#92400e',
  '#78716c',
  '#64748b',
] as const

export type OrganizerColor = (typeof ORGANIZER_COLORS)[number]

const CUSTOM_ORGANIZER_COLOR = /^#[0-9a-f]{6}$/i

export const ORGANIZER_COLOR_MIN_CONTRAST = 3

/**
 * Whether an organiser colour can be told apart from the surface it sits on. An unresolvable
 * surface (a CSS variable the reader cannot compute) is treated as visible: the guard exists to
 * stop a user painting a folder the same colour as its background, not to block themes it
 * cannot see.
 */
export function isOrganizerColorVisible(color: string, background: string): boolean {
  const seen = organizerColorContrast(color, background)
  return seen === null || seen >= ORGANIZER_COLOR_MIN_CONTRAST
}
export function organizerColorLabel(color: string, translate: (key: MessageKey) => string): string {
  const key = (ORGANIZER_COLOR_MESSAGE_KEYS as Record<string, MessageKey | undefined>)[color]
  if (key)
    return translate(key)
  return `${translate('color.custom')} ${color.toLocaleLowerCase()}`
}

export function isOrganizerColor(value: unknown): value is OrganizerColor {
  return typeof value === 'string' && (ORGANIZER_COLORS as readonly string[]).includes(value)
}

/** A six-digit hex the author mixed themselves, outside the preset ramp. */
export function isCustomOrganizerColor(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_ORGANIZER_COLOR.test(value) && !isOrganizerColor(value)
}

export function organizerColorOrNull(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  if (isOrganizerColor(value))
    return value
  return isCustomOrganizerColor(value) ? value.toLocaleLowerCase() : null
}

function srgbChannel(unit: number): number {
  const scaled = unit / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/**
 * Resolve the colour a theme actually painted with: a hex, an `rgb()` triple, or the `oklch()`
 * form the design tokens use — `getComputedStyle` hands back whichever the author wrote.
 */
function toRgbTriplet(value: string): [number, number, number] | null {
  const text = value.trim()
  if (CUSTOM_ORGANIZER_COLOR.test(text))
    return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)]
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(text)
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 0.01)
      return null
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  const oklch = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s+([\d.-]+)/i.exec(text)
  if (oklch) {
    const L = Number(oklch[1]) * (oklch[2] ? 0.01 : 1)
    const C = Number(oklch[3])
    const H = Number(oklch[4]) * Math.PI / 180
    const aOkl = C * Math.cos(H)
    const bOkl = C * Math.sin(H)
    const l = L + 0.3963377774 * aOkl + 0.2158037573 * bOkl
    const m = L - 0.1055613458 * aOkl - 0.0638541728 * bOkl
    const s2 = L - 0.0894841775 * aOkl - 1.291485548 * bOkl
    const gamma = (x: number) => Math.min(255, Math.max(0, 255 * (x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92)))
    return [
      gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2),
      gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2),
      gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s2),
    ]
  }
  return null
}

export function isResolvedOrganizerColor(value: string): boolean {
  return toRgbTriplet(value) !== null
}

function relativeLuminance(value: string): number | null {
  const rgb = toRgbTriplet(value)
  if (!rgb)
    return null
  return 0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2])
}

/**
 * WCAG contrast between an organiser colour and the surface it is painted on. A folder icon and a
 * tag pill carry no other weight, so a colour closer than 3:1 to the theme simply disappears.
 * Null means "not two plain hexes", which callers must read as unknown rather than as a pass.
 */
export function organizerColorContrast(color: string, background: string): number | null {
  const fg = relativeLuminance(color)
  const bg = relativeLuminance(background)
  if (fg === null || bg === null)
    return null
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

// Both the console and the MCP tools store icons truncated, so the limit lives
// next to the colour list rather than at each call site.
export function normalizeOrganizerIcon(icon: string | null | undefined): string | null {
  return icon ? truncateText(icon, LIMITS.organizerIconMaxLength) || null : null
}
