/**
 * What a type or a category looks like.
 *
 * The reference project kept both as bare strings typed into a form and drew every one of them the
 * same way: one generic tag glyph for every category, one layer glyph for every type, and a bar on
 * its dashboard coloured by *rank in the money league table*, so a service changed colour the moment
 * another one overtook it in spend. Identity that belongs to a name, not to a position, is what this
 * module fixes: one name resolves to one icon and one colour everywhere — the list avatar, the rail,
 * the share bars, the detail header and the notification body — and it keeps them until the reader
 * says otherwise.
 *
 * Resolution is three tiers, cheapest first to declare and last to win:
 *   1. what the reader picked for this exact label, stored in the registry;
 *   2. what a built-in preset ships with, so a fresh account's first type looks deliberate;
 *   3. a hash of the label into the organiser palette, so a name nobody configured is still stable
 *      across devices and does not need a row to have a face.
 *
 * Icons are stored the way the kanban fence stores them — `lucide:<ComponentName>` — so one encoding
 * covers the app and a picker and a renderer cannot drift about what a stored icon means.
 */

import { ORGANIZER_COLORS, type OrganizerColor } from '../organizer-colors'
import type { MessageKey } from '../locales/en-US'

/** The `lucide:` prefix, as the kanban badge spells it too. */
const LUCIDE_PREFIX = 'lucide:'

export interface IconGroup {
  key: MessageKey
  icons: readonly IconSpec[]
}

export interface IconSpec {
  /** The lucide-react component name, without the prefix. */
  name: string
  labelKey: MessageKey
}

/**
 * The icons on offer, grouped so the picker can be scanned rather than read.
 *
 * Forty-two, chosen for what a subscription actually is — a stream, a server, a domain, a gym — not
 * for coverage of the lucide set. A reader who wants a face that is not here is one `lucide:` away
 * from adding it, and nothing about the stored format changes when they do.
 *
 * Every name a preset wears must appear below: `lucideNameOf` rejects what is not offered, so a preset
 * pointing outside this list would draw nothing and read as a bug in the preset rather than in the list.
 */
export const SUBSCRIPTION_ICON_GROUPS: readonly IconGroup[] = [
  {
    key: 'subscriptions.icon_group.media',
    icons: [
      { name: 'Tv', labelKey: 'subscriptions.icon.tv' },
      { name: 'Music', labelKey: 'subscriptions.icon.music' },
      { name: 'Clapperboard', labelKey: 'subscriptions.icon.clapperboard' },
      { name: 'Gamepad2', labelKey: 'subscriptions.icon.gamepad' },
      { name: 'BookOpen', labelKey: 'subscriptions.icon.book' },
      { name: 'GraduationCap', labelKey: 'subscriptions.icon.graduation_cap' },
      { name: 'Newspaper', labelKey: 'subscriptions.icon.newspaper' },
      { name: 'Radio', labelKey: 'subscriptions.icon.radio' },
      { name: 'MessageCircle', labelKey: 'subscriptions.icon.message' },
    ],
  },
  {
    key: 'subscriptions.icon_group.tech',
    icons: [
      { name: 'Cloud', labelKey: 'subscriptions.icon.cloud' },
      { name: 'Server', labelKey: 'subscriptions.icon.server' },
      { name: 'Globe', labelKey: 'subscriptions.icon.globe' },
      { name: 'Smartphone', labelKey: 'subscriptions.icon.smartphone' },
      { name: 'Monitor', labelKey: 'subscriptions.icon.monitor' },
      { name: 'Cpu', labelKey: 'subscriptions.icon.cpu' },
      { name: 'Wifi', labelKey: 'subscriptions.icon.wifi' },
      { name: 'Shield', labelKey: 'subscriptions.icon.shield' },
    ],
  },
  {
    key: 'subscriptions.icon_group.tools',
    icons: [
      { name: 'AppWindow', labelKey: 'subscriptions.icon.app_window' },
      { name: 'Code', labelKey: 'subscriptions.icon.code' },
      { name: 'PenLine', labelKey: 'subscriptions.icon.pen' },
      { name: 'Bot', labelKey: 'subscriptions.icon.bot' },
      { name: 'Sparkles', labelKey: 'subscriptions.icon.sparkles' },
      { name: 'Package', labelKey: 'subscriptions.icon.package' },
      { name: 'HardDrive', labelKey: 'subscriptions.icon.hard_drive' },
      { name: 'Tag', labelKey: 'subscriptions.icon.tag' },
    ],
  },
  {
    key: 'subscriptions.icon_group.life',
    icons: [
      { name: 'Coffee', labelKey: 'subscriptions.icon.coffee' },
      { name: 'UtensilsCrossed', labelKey: 'subscriptions.icon.utensils' },
      { name: 'Plane', labelKey: 'subscriptions.icon.plane' },
      { name: 'Car', labelKey: 'subscriptions.icon.car' },
      { name: 'Dumbbell', labelKey: 'subscriptions.icon.dumbbell' },
      { name: 'HeartPulse', labelKey: 'subscriptions.icon.heart_pulse' },
      { name: 'Cake', labelKey: 'subscriptions.icon.cake' },
      { name: 'Gift', labelKey: 'subscriptions.icon.gift' },
      { name: 'User', labelKey: 'subscriptions.icon.user' },
      { name: 'Home', labelKey: 'subscriptions.icon.home' },
    ],
  },
  {
    key: 'subscriptions.icon_group.money',
    icons: [
      { name: 'CreditCard', labelKey: 'subscriptions.icon.credit_card' },
      { name: 'Crown', labelKey: 'subscriptions.icon.crown' },
      { name: 'Gem', labelKey: 'subscriptions.icon.gem' },
      { name: 'Ticket', labelKey: 'subscriptions.icon.ticket' },
      { name: 'Wallet', labelKey: 'subscriptions.icon.wallet' },
      { name: 'Briefcase', labelKey: 'subscriptions.icon.briefcase' },
      { name: 'Building2', labelKey: 'subscriptions.icon.building' },
    ],
  },
]

/** Every icon name the picker may offer, in group order. */
export const SUBSCRIPTION_ICON_NAMES: readonly string[] = SUBSCRIPTION_ICON_GROUPS.flatMap(
  (group) => group.icons.map((icon) => icon.name),
)

/** A stored icon value, or null when there is nothing to draw. */
export function iconValueOf(name: string): string {
  return `${LUCIDE_PREFIX}${name}`
}

/** The bare component name out of a stored icon, or null when it is not a lucide icon. */
export function lucideNameOf(icon: string | null | undefined): string | null {
  if (typeof icon !== 'string' || !icon.startsWith(LUCIDE_PREFIX)) return null
  const name = icon.slice(LUCIDE_PREFIX.length)
  return SUBSCRIPTION_ICON_NAMES.includes(name) ? name : null
}

/**
 * An icon the reader chose, or null.
 *
 * Anything outside the offered set is dropped rather than stored: the renderer only resolves names it
 * was given, so a value that survives here but not there would draw an empty tile forever, and an
 * empty tile is harder to explain to the reader than a silently unset icon.
 */
export function normalizeIcon(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const name = lucideNameOf(trimmed)
  return name ? iconValueOf(name) : null
}

/**
 * A colour the reader chose, or null.
 *
 * Only the preset ramp is accepted. The folder menus allow a hand-mixed hex, but a subscription label
 * is tinted against surfaces this module cannot measure, and one of the sixteen is already more choice
 * than a category needs.
 */
export function normalizeColor(value: unknown): OrganizerColor | null {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLocaleLowerCase()
  return (ORGANIZER_COLORS as readonly string[]).includes(lower)
    ? (lower as OrganizerColor)
    : null
}

/**
 * The colours a label may take, as the palette spells them.
 *
 * Exported so the picker and any future consumer read the same ramp instead of each keeping its own
 * copy of a list that is already the app's answer to "which accent colours are safe on our surfaces".
 */
export const SUBSCRIPTION_COLORS: readonly OrganizerColor[] = ORGANIZER_COLORS

/**
 * The built-in types, offered before the reader has saved anything.
 *
 * The names are localized, so the value that lands in `sub_item.custom_type` is whatever the reader's
 * language called it — the same free text the reference project stored, just no longer an empty box on
 * a fresh account. Each carries the face it should have had from the start.
 */
export interface LabelPreset {
  key: MessageKey
  icon: string
}

export const TYPE_PRESETS: readonly LabelPreset[] = [
  { key: 'subscriptions.type.streaming', icon: 'Tv' },
  { key: 'subscriptions.type.video', icon: 'Clapperboard' },
  { key: 'subscriptions.type.music', icon: 'Music' },
  { key: 'subscriptions.type.cloud', icon: 'Cloud' },
  { key: 'subscriptions.type.software', icon: 'AppWindow' },
  { key: 'subscriptions.type.domain', icon: 'Globe' },
  { key: 'subscriptions.type.server', icon: 'Server' },
  { key: 'subscriptions.type.membership', icon: 'Crown' },
  { key: 'subscriptions.type.learning', icon: 'BookOpen' },
  { key: 'subscriptions.type.fitness', icon: 'Dumbbell' },
  { key: 'subscriptions.type.gaming', icon: 'Gamepad2' },
  { key: 'subscriptions.type.news', icon: 'Newspaper' },
  { key: 'subscriptions.type.ai', icon: 'Bot' },
  { key: 'subscriptions.type.birthday', icon: 'Cake' },
  { key: 'subscriptions.type.anniversary', icon: 'Gift' },
  { key: 'subscriptions.type.other', icon: 'Tag' },
]

export const CATEGORY_PRESETS: readonly LabelPreset[] = [
  { key: 'subscriptions.category.personal', icon: 'User' },
  { key: 'subscriptions.category.family', icon: 'Home' },
  { key: 'subscriptions.category.work', icon: 'Briefcase' },
  { key: 'subscriptions.category.company', icon: 'Building2' },
  { key: 'subscriptions.category.entertainment', icon: 'Clapperboard' },
  { key: 'subscriptions.category.study', icon: 'GraduationCap' },
  { key: 'subscriptions.category.development', icon: 'Code' },
  { key: 'subscriptions.category.productivity', icon: 'PenLine' },
  { key: 'subscriptions.category.social', icon: 'MessageCircle' },
  { key: 'subscriptions.category.health', icon: 'HeartPulse' },
  { key: 'subscriptions.category.finance', icon: 'CreditCard' },
  { key: 'subscriptions.category.other', icon: 'Tag' },
]

/**
 * The built-in face a saved name matches, or null.
 *
 * A preset wins where the reader's saved text is exactly what a preset was called in their language,
 * which is the common case and the one that should look designed rather than derived.
 *
 * `resolve` turns a preset key into its label; the caller owns the catalog, this module does not
 * import the browser.
 */
export function presetFor(
  label: string,
  kind: 'type' | 'category',
  resolve: (key: MessageKey) => string,
): LabelPreset | null {
  const list = kind === 'type' ? TYPE_PRESETS : CATEGORY_PRESETS
  const wanted = label.trim()
  if (!wanted) return null
  for (const preset of list) {
    if (resolve(preset.key) === wanted) return preset
  }
  return null
}

/**
 * The slot a label wants in a ramp of `count`, chosen by hashing its name.
 *
 * FNV-1a over code points. Any deterministic hash would do; this one is a few multiplies and needs no
 * dependency. Stability is the whole point: the reference project coloured by rank, so a service changed
 * colour whenever another overtook it in spend, and a reader who learns an app by its colour loses that
 * every month. A caller that must not repeat a colour within one set probes forward from here, which
 * keeps the churn to the labels that actually collide.
 */
export function colorIndexOf(label: string, count: number): number {
  let hash = 0x811c9dc5
  for (const point of label.trim()) {
    hash ^= point.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return count > 0 ? Math.abs(hash) % count : 0
}

/**
 * The icon a label should wear when nobody chose one.
 *
 * Returns the bare component name. Only presets carry one: an invented name has nothing honest to map
 * it to, and a hash-chosen icon would imply the reader's "Figma" looks like a gym membership.
 */
export function presetIconOf(label: string, kind: 'type' | 'category', resolve: (key: MessageKey) => string): string | null {
  return presetFor(label, kind, resolve)?.icon ?? null
}

/**
 * A label's identity, resolved.
 *
 * `stored` is what the registry holds — either may be empty. The tiers are applied per axis, so a
 * reader who picked a colour but no icon keeps the preset's icon rather than losing it to their own
 * half-finished choice.
 *
 * A colour of `null` means nobody picked one, which is not the same as a colour that was not found:
 * what an unpicked label looks like belongs to the account's accent, and only the surface drawing it
 * can say what that accent is right now.
 */
export function resolveIdentity(input: {
  label: string
  kind: 'type' | 'category'
  storedIcon?: string | null
  storedColor?: string | null
  resolve: (key: MessageKey) => string
}): { icon: string | null; color: OrganizerColor | null } {
  const icon = normalizeIcon(input.storedIcon)
    ?? (() => {
      const name = presetIconOf(input.label, input.kind, input.resolve)
      return name ? iconValueOf(name) : null
    })()
  return { icon, color: normalizeColor(input.storedColor) }
}
