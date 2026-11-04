/**
 * Which project colour a tag wears when the tag has never picked one.
 *
 * The mapping is a hash of the tag name into the existing colour tokens, so the same tag reads the
 * same in light and dark, on every device, and no second palette is introduced. The pill keeps the
 * theme's text token and only tints its frame, which is what keeps the label above the AA floor.
 */
const TAG_COLOR_TOKENS = [
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  'var(--accent)',
] as const

/** A 32-bit FNV-1a hash; stable across locales and sessions, unlike `String.length % n`. */
function hashName(name: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index++) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash
}

export function tagColorFor(name: string, stored: string | null | undefined): string {
  if (stored) return stored
  return TAG_COLOR_TOKENS[hashName(name.toLowerCase()) % TAG_COLOR_TOKENS.length]!
}

export const TAG_COLOR_PALETTE = TAG_COLOR_TOKENS

/** The frame a tag pill paints from its colour: a tinted background and a readable border. */
export function tagPillStyle(name: string, stored: string | null | undefined): { backgroundColor: string; borderColor: string } {
  const color = tagColorFor(name, stored)
  return {
    backgroundColor: `color-mix(in oklab, ${color} 12%, var(--bg-raised))`,
    borderColor: `color-mix(in oklab, ${color} 42%, var(--border-subtle))`,
  }
}
