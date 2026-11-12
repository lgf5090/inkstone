/**
 * The option colour vocabulary, and the palette it is drawn with.
 *
 * An archive spells a colour as the reference's `propColorRed`; the app already owns a calibrated
 * tag palette in `styles/tokens.css`, whose nine named colours overlap the reference's by name
 * (port plan D-03). Resolving to those tokens rather than importing the kanban engine keeps this
 * module's chunk free of that engine, and keeps the contrast calibration that palette already carries.
 *
 * The stored string stays the reference's token so an export still round-trips; only the reader maps.
 */
const OPTION_COLOR_NAMES = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const

export type ProjectOptionColorName = (typeof OPTION_COLOR_NAMES)[number]

/** The picker's ramp, in the reference's own spelling and order. `''` is the no-colour slot. */
export const PROJECT_OPTION_COLORS: readonly string[] = OPTION_COLOR_NAMES.map(
  (name) => `propColor${name[0]!.toUpperCase()}${name.slice(1)}`,
)

/** The palette name a stored colour names, or `''` for none — including the reference's `propColorDefault`. */
export function projectOptionColorName(color: string): ProjectOptionColorName | '' {
  const index = PROJECT_OPTION_COLORS.indexOf(color)
  return index < 0 ? '' : OPTION_COLOR_NAMES[index]!
}

/** The CSS colour a chip's text and dot are painted in, or `null` when the option carries no colour. */
export function projectOptionCssColor(color: string): string | null {
  const name = projectOptionColorName(color)
  return name ? `var(--kanban-tag-${name}-fg)` : null
}

/**
 * The colour a card wears on every surface: its first single-select value's colour, else the accent.
 *
 * One rule for the board dot, the calendar ribbon, the schedule bar and the gallery placeholder, so a
 * card is the same colour wherever the reader meets it. `select` only — a multi-select card has no
 * single colour to wear, and picking its first tag would change with tag order.
 */
export function projectCardColor(
  card: { values: Record<string, string> },
  properties: readonly { id: string, type: string, options: readonly { id: string, color: string }[] }[],
): string {
  for (const property of properties) {
    if (property.type !== 'select') continue
    const raw = card.values[property.id]
    if (!raw) continue
    const option = property.options.find((entry) => entry.id === raw)
    const css = option ? projectOptionCssColor(option.color) : null
    if (css) return css
  }
  return 'var(--accent)'
}