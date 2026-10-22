/**
 * The glyphs a to-do list can wear.
 *
 * The kanban block's thirteen icons are a column vocabulary — check, clock, flag — and a list is a
 * different thing: it is a place work lives (a client, a course, a household). So this registry is its
 * own set, grouped the way a reader thinks about their lists rather than by glyph shape.
 *
 * The value stored on a list is `lucide:<Name>`, the same shape the kanban block writes, so a list icon
 * moved between the two surfaces still resolves. An emoji is stored as itself and is drawn as text.
 */
import type { ComponentType } from 'react'
import {
  Apple,
  Banknote,
  Bike,
  BookMarked,
  BookOpen,
  Briefcase,
  Building2,
  Camera,
  Car,
  ChartPie,
  CheckCircle,
  Coffee,
  Coins,
  Compass,
  CreditCard,
  Dumbbell,
  Film,
  Flag,
  Folder,
  Gamepad2,
  Gift,
  GraduationCap,
  Headphones,
  HeartPulse,
  Home,
  Languages,
  Lightbulb,
  MapPin,
  Music,
  Package,
  Pencil,
  PiggyBank,
  Pill,
  Plane,
  Presentation,
  Receipt,
  Rocket,
  Shirt,
  ShoppingCart,
  Sparkles,
  Star,
  Stethoscope,
  Tag,
  Target,
  Ticket,
  TrainFront,
  Utensils,
  Wallet,
} from 'lucide-react'
import type { MessageKey } from '../../lib/i18n'

export interface ListIconOption {
  /** The lucide export name, stored as `lucide:<name>`. */
  name: string
  icon: ComponentType<{ size?: number; className?: string }>
  labelKey: MessageKey
}

export interface ListIconGroup {
  id: string
  labelKey: MessageKey
  icons: readonly ListIconOption[]
}

/** Every icon a list may pick, in the order the picker draws them. */
export const LIST_ICON_GROUPS: readonly ListIconGroup[] = [
  {
    id: 'work',
    labelKey: 'todo.icon.group.work',
    icons: [
      { name: 'Briefcase', icon: Briefcase, labelKey: 'todo.icon.briefcase' },
      { name: 'Building2', icon: Building2, labelKey: 'todo.icon.building' },
      { name: 'Presentation', icon: Presentation, labelKey: 'todo.icon.presentation' },
      { name: 'Target', icon: Target, labelKey: 'todo.icon.target' },
      { name: 'Rocket', icon: Rocket, labelKey: 'todo.icon.rocket' },
      { name: 'ChartPie', icon: ChartPie, labelKey: 'todo.icon.chart' },
    ],
  },
  {
    id: 'study',
    labelKey: 'todo.icon.group.study',
    icons: [
      { name: 'GraduationCap', icon: GraduationCap, labelKey: 'todo.icon.graduation' },
      { name: 'BookOpen', icon: BookOpen, labelKey: 'todo.icon.book' },
      { name: 'BookMarked', icon: BookMarked, labelKey: 'todo.icon.bookmark' },
      { name: 'Pencil', icon: Pencil, labelKey: 'todo.icon.pencil' },
      { name: 'Languages', icon: Languages, labelKey: 'todo.icon.languages' },
      { name: 'Lightbulb', icon: Lightbulb, labelKey: 'todo.icon.idea' },
    ],
  },
  {
    id: 'life',
    labelKey: 'todo.icon.group.life',
    icons: [
      { name: 'Home', icon: Home, labelKey: 'todo.icon.home' },
      { name: 'Coffee', icon: Coffee, labelKey: 'todo.icon.coffee' },
      { name: 'Utensils', icon: Utensils, labelKey: 'todo.icon.food' },
      { name: 'ShoppingCart', icon: ShoppingCart, labelKey: 'todo.icon.cart' },
      { name: 'Shirt', icon: Shirt, labelKey: 'todo.icon.shirt' },
      { name: 'Gift', icon: Gift, labelKey: 'todo.icon.gift' },
    ],
  },
  {
    id: 'health',
    labelKey: 'todo.icon.group.health',
    icons: [
      { name: 'Dumbbell', icon: Dumbbell, labelKey: 'todo.icon.dumbbell' },
      { name: 'HeartPulse', icon: HeartPulse, labelKey: 'todo.icon.pulse' },
      { name: 'Stethoscope', icon: Stethoscope, labelKey: 'todo.icon.stethoscope' },
      { name: 'Pill', icon: Pill, labelKey: 'todo.icon.pill' },
      { name: 'Apple', icon: Apple, labelKey: 'todo.icon.apple' },
      { name: 'Bike', icon: Bike, labelKey: 'todo.icon.bike' },
    ],
  },
  {
    id: 'money',
    labelKey: 'todo.icon.group.money',
    icons: [
      { name: 'Wallet', icon: Wallet, labelKey: 'todo.icon.wallet' },
      { name: 'CreditCard', icon: CreditCard, labelKey: 'todo.icon.card' },
      { name: 'PiggyBank', icon: PiggyBank, labelKey: 'todo.icon.piggy' },
      { name: 'Receipt', icon: Receipt, labelKey: 'todo.icon.receipt' },
      { name: 'Banknote', icon: Banknote, labelKey: 'todo.icon.banknote' },
      { name: 'Coins', icon: Coins, labelKey: 'todo.icon.coins' },
    ],
  },
  {
    id: 'travel',
    labelKey: 'todo.icon.group.travel',
    icons: [
      { name: 'Car', icon: Car, labelKey: 'todo.icon.car' },
      { name: 'Plane', icon: Plane, labelKey: 'todo.icon.plane' },
      { name: 'TrainFront', icon: TrainFront, labelKey: 'todo.icon.train' },
      { name: 'MapPin', icon: MapPin, labelKey: 'todo.icon.pin' },
      { name: 'Compass', icon: Compass, labelKey: 'todo.icon.compass' },
      { name: 'Package', icon: Package, labelKey: 'todo.icon.package' },
    ],
  },
  {
    id: 'fun',
    labelKey: 'todo.icon.group.fun',
    icons: [
      { name: 'Music', icon: Music, labelKey: 'todo.icon.music' },
      { name: 'Film', icon: Film, labelKey: 'todo.icon.film' },
      { name: 'Camera', icon: Camera, labelKey: 'todo.icon.camera' },
      { name: 'Gamepad2', icon: Gamepad2, labelKey: 'todo.icon.gamepad' },
      { name: 'Headphones', icon: Headphones, labelKey: 'todo.icon.headphones' },
      { name: 'Ticket', icon: Ticket, labelKey: 'todo.icon.ticket' },
    ],
  },
  {
    id: 'symbols',
    labelKey: 'todo.icon.group.symbols',
    icons: [
      { name: 'Star', icon: Star, labelKey: 'todo.icon.star' },
      { name: 'Flag', icon: Flag, labelKey: 'todo.icon.flag' },
      { name: 'Tag', icon: Tag, labelKey: 'todo.icon.tag' },
      { name: 'Folder', icon: Folder, labelKey: 'todo.icon.folder' },
      { name: 'CheckCircle', icon: CheckCircle, labelKey: 'todo.icon.check' },
      { name: 'Sparkles', icon: Sparkles, labelKey: 'todo.icon.sparkles' },
    ],
  },
]

/** Every option, flattened, for a lookup by stored name. */
export const LIST_ICONS: readonly ListIconOption[] = LIST_ICON_GROUPS.flatMap((group) => group.icons)

/** The icon a stored `lucide:<Name>` names, or null for an emoji, a misspelling, or no icon. */
export function listIconOption(icon: string | null | undefined): ListIconOption | null {
  if (!icon?.startsWith('lucide:')) return null
  return LIST_ICONS.find((option) => option.name === icon.slice(7)) ?? null
}

/** Draws a list's stored icon: the lucide glyph, or the emoji the reader picked. */
export function ListIcon({ icon, size = 14, className }: {
  icon: string | null | undefined
  size?: number
  className?: string
}) {
  const option = listIconOption(icon)
  if (option) {
    const Component = option.icon
    return <Component size={size} className={className ?? 'shrink-0 text-[var(--accent)]'} />
  }
  // A bare word — which only the API can let in, since the picker writes `lucide:` or one emoji — is
  // not an icon: drawing its first letters would read as a typo beside the list's name. Nothing is the
  // honest answer for a value this app cannot render.
  if (!icon || [...icon].length > 3) return null
  return <span className={className ?? 'shrink-0 leading-none'} style={{ fontSize: size }}>{icon}</span>
}
