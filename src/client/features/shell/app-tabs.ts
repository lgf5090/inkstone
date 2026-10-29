/**
 * The app tabs, as data: one entry per button on the left rail, and the one place that knows
 * which URL path belongs to which container.
 *
 * The notebook and the assistant have implementations; the rest answer to a real path and show their
 * placeholder, so adding an app means writing its component and naming it in the host's container
 * list — the rail, the router and the deploy config already carry it.
 *
 * A new `path` has to be added to `run_worker_first` in both wrangler configs as well, or the
 * document served at that address comes from the asset layer's SPA fallback and never picks up the
 * worker's Content-Security-Policy. tests/app-tab-routes.test.ts is what says so out loud.
 */
import type { ComponentType } from 'react'
import { BookOpen, CalendarDays, Cloud, Compass, FileText, FolderKanban, Images, ListChecks, Mail, MessageSquare, Music, NotebookPen, PlaySquare, Rss, StickyNote, Terminal, Wallet, Wrench } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'

export type AppTabId =
  | 'notes'
  | 'inknote'
  | 'memos'
  | 'calendar'
  | 'todo'
  | 'email'
  | 'projects'
  | 'nav'
  | 'chat'
  | 'subscriptions'
  | 'reading'
  | 'rss'
  | 'imgbed'
  | 'music'
  | 'cloudflare'
  | 'youtube'
  | 'tools'
  | 'development'

export interface AppTab {
  id: AppTabId
  /** The address this container answers to, and the only spelling the rail links with. */
  path: string
  labelKey: MessageKey
  icon: ComponentType<{ size?: number }>
}

export const APP_TABS: readonly AppTab[] = [
  { id: 'notes', path: '/notes', labelKey: 'app.tabs.notes', icon: FileText },
  { id: 'inknote', path: '/inknote', labelKey: 'app.tabs.inknote', icon: NotebookPen },
  { id: 'memos', path: '/memos', labelKey: 'app.tabs.memos', icon: StickyNote },
  { id: 'calendar', path: '/calendar', labelKey: 'app.tabs.calendar', icon: CalendarDays },
  { id: 'todo', path: '/todo', labelKey: 'app.tabs.todo', icon: ListChecks },
  { id: 'email', path: '/email', labelKey: 'app.tabs.email', icon: Mail },
  { id: 'projects', path: '/projects', labelKey: 'app.tabs.projects', icon: FolderKanban },
  { id: 'nav', path: '/nav', labelKey: 'app.tabs.nav', icon: Compass },
  { id: 'chat', path: '/chat', labelKey: 'app.tabs.chat', icon: MessageSquare },
  { id: 'subscriptions', path: '/subscriptions', labelKey: 'app.tabs.subscriptions', icon: Wallet },
  { id: 'reading', path: '/reading', labelKey: 'app.tabs.reading', icon: BookOpen },
  { id: 'rss', path: '/rss', labelKey: 'app.tabs.rss', icon: Rss },
  { id: 'imgbed', path: '/imgbed', labelKey: 'app.tabs.imgbed', icon: Images },
  { id: 'music', path: '/music', labelKey: 'app.tabs.music', icon: Music },
  { id: 'cloudflare', path: '/cloudflare', labelKey: 'app.tabs.cloudflare', icon: Cloud },
  { id: 'youtube', path: '/youtube', labelKey: 'app.tabs.youtube', icon: PlaySquare },
  { id: 'tools', path: '/tools', labelKey: 'app.tabs.tools', icon: Wrench },
  { id: 'development', path: '/development', labelKey: 'app.tabs.development', icon: Terminal },
]

/**
 * The container a reader gets when nothing in the address names one. This is what makes the bare
 * origin the notebook, and it is also where a note's own deep link (`/n/<id>`, which the shell
 * opens once the vault has hydrated) and any mistyped address land.
 */
export const DEFAULT_APP_TAB: AppTabId = 'notes'

/** Containers that own their own sub-addresses, so a deep link stays on the tab that made it. */
const NESTED_TAB_PATHS: readonly [prefix: string, id: AppTabId][] = [
  ['/inknote/', 'inknote'],
  ['/reading/', 'reading'],
  ['/imgbed/', 'imgbed'],
  ['/memos/', 'memos'],
  ['/email/', 'email'],
  ['/music/', 'music'],
  ['/cloudflare/', 'cloudflare'],
  ['/youtube/', 'youtube'],
  ['/tools/', 'tools'],
  ['/development/', 'development'],
]

const TAB_BY_PATH = new Map(APP_TABS.map((tab) => [tab.path, tab.id]))

export function appTab(id: AppTabId): AppTab {
  return APP_TABS.find((entry) => entry.id === id)!
}

/** The tab an address belongs to. Anything unrecognised answers with the notebook. */
export function tabIdForPath(pathname: string): AppTabId {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const exact = TAB_BY_PATH.get(path)
  if (exact) return exact
  for (const [prefix, id] of NESTED_TAB_PATHS) {
    if (pathname.startsWith(prefix)) return id
  }
  return DEFAULT_APP_TAB
}
