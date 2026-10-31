import {
  Banknote,
  Briefcase,
  Cloud,
  FolderTree,
  Gamepad2,
  Globe,
  KeyRound,
  Mail,
  Server,
  ShieldCheck,
  ShoppingBag,
  Users,
  type LucideIcon,
} from 'lucide-react'

/**
 * The icons a group may wear. A short curated list, not the folder system's 500: a password group
 * is a category ("work", "banking"), and a picker nobody finishes is worse than twelve clear ones.
 */
export const GROUP_ICONS: readonly { id: string; icon: LucideIcon }[] = [
  { id: 'folder', icon: FolderTree },
  { id: 'briefcase', icon: Briefcase },
  { id: 'bank', icon: Banknote },
  { id: 'key', icon: KeyRound },
  { id: 'globe', icon: Globe },
  { id: 'mail', icon: Mail },
  { id: 'shopping', icon: ShoppingBag },
  { id: 'games', icon: Gamepad2 },
  { id: 'cloud', icon: Cloud },
  { id: 'server', icon: Server },
  { id: 'team', icon: Users },
  { id: 'secure', icon: ShieldCheck },
]

const BY_ID = new Map(GROUP_ICONS.map((entry) => [entry.id, entry.icon]))

/** The icon a stored id names, or null when the row has none (or one this build dropped). */
export function groupIcon(id: string | undefined): LucideIcon | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}
