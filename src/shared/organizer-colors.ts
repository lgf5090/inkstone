import { LIMITS } from './constants'
import { truncateText } from './text-utils'
import type { MessageKey } from './locales/en-US'

export const ORGANIZER_COLOR_MESSAGE_KEYS = {
  '#dc2626': 'color.red',
  '#ea580c': 'color.orange',
  '#ca8a04': 'color.amber',
  '#65a30d': 'color.olive',
  '#059669': 'color.emerald',
  '#0891b2': 'color.cyan',
  '#4f46e5': 'color.indigo',
  '#9333ea': 'color.purple',
  '#db2777': 'color.magenta',
  '#64748b': 'color.slate',
} as const satisfies Record<(typeof ORGANIZER_COLORS)[number], MessageKey>

export const ORGANIZER_COLORS = [
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#65a30d',
  '#059669',
  '#0891b2',
  '#4f46e5',
  '#9333ea',
  '#db2777',
  '#64748b',
] as const

export type OrganizerColor = (typeof ORGANIZER_COLORS)[number]

export function organizerColorLabel(color: string, translate: (key: MessageKey) => string): string {
  const key = (ORGANIZER_COLOR_MESSAGE_KEYS as Record<string, MessageKey | undefined>)[color]
  return key ? translate(key) : color
}

export function isOrganizerColor(value: unknown): value is OrganizerColor {
  return typeof value === 'string' && (ORGANIZER_COLORS as readonly string[]).includes(value)
}

export function organizerColorOrNull(value: unknown): OrganizerColor | null {
  return isOrganizerColor(value) ? value : null
}

// Both the console and the MCP tools store icons truncated, so the limit lives
// next to the colour list rather than at each call site.
export function normalizeOrganizerIcon(icon: string | null | undefined): string | null {
  return icon ? truncateText(icon, LIMITS.organizerIconMaxLength) || null : null
}
