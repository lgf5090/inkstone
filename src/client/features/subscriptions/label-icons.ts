/**
 * The lucide components behind the icon names the subscription registry stores.
 *
 * The names live in `@shared/subscriptions/identity` because the worker has to validate what it is
 * being asked to save, and the components live here because the worker must not import a browser icon
 * set. That is two lists, which is the drift the guard test in `label-identity.test.tsx` exists to
 * close: a name offered without a component draws an empty tile, and a component without a name is
 * dead weight in the bundle.
 *
 * Kanban keeps both in one client list; it can, because nothing server-side ever has to decide whether
 * a board's icon is real. Here the route does, so the split is the price of validating on write.
 */
import {
  AppWindow,
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Cake,
  Car,
  Clapperboard,
  Cloud,
  Code,
  Coffee,
  CreditCard,
  Crown,
  Cpu,
  Dumbbell,
  Gamepad2,
  Gem,
  Gift,
  Globe,
  GraduationCap,
  HardDrive,
  HeartPulse,
  Home,
  MessageCircle,
  Monitor,
  Music,
  Newspaper,
  Package,
  PenLine,
  Plane,
  Radio,
  Server,
  Shield,
  Smartphone,
  Sparkles,
  Tag,
  Ticket,
  Tv,
  User,
  UtensilsCrossed,
  Wallet,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import { SUBSCRIPTION_ICON_NAMES } from '@shared/subscriptions/identity'

/** The 42 components, keyed by the bare name the stored `lucide:<Name>` value carries. */
const ICON_COMPONENTS: Record<string, LucideIcon> = {
  AppWindow,
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Cake,
  Car,
  Clapperboard,
  Cloud,
  Code,
  Coffee,
  CreditCard,
  Crown,
  Cpu,
  Dumbbell,
  Gamepad2,
  Gem,
  Gift,
  Globe,
  GraduationCap,
  HardDrive,
  HeartPulse,
  Home,
  MessageCircle,
  Monitor,
  Music,
  Newspaper,
  Package,
  PenLine,
  Plane,
  Radio,
  Server,
  Shield,
  Smartphone,
  Sparkles,
  Tag,
  Ticket,
  Tv,
  User,
  UtensilsCrossed,
  Wallet,
  Wifi,
}

/**
 * The component for a stored icon value, or null.
 *
 * Null is a real answer rather than a failure: a label with no chosen face has one derived from its
 * preset, and a label with no preset draws its initial. Callers fall back rather than drawing a hole.
 */
export function iconComponentOf(icon: string | null | undefined): LucideIcon | null {
  if (typeof icon !== 'string' || !icon.startsWith('lucide:')) return null
  return ICON_COMPONENTS[icon.slice('lucide:'.length)] ?? null
}

/** Every name that has a component here, for the guard test to compare against the shared list. */
export const ICON_COMPONENT_NAMES: readonly string[] = Object.keys(ICON_COMPONENTS)

/** Asserted at module load so a mismatch fails loudly in development instead of drawing nothing. */
if (import.meta.env.DEV) {
  const missing = SUBSCRIPTION_ICON_NAMES.filter((name) => !ICON_COMPONENTS[name])
  if (missing.length) {
    console.warn(`[subscriptions] icons offered without a component: ${missing.join(', ')}`)
  }
}
