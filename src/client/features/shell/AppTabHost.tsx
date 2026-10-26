/**
 * The frame the app tabs live in: the rail on the left, one container on the right.
 *
 * The sync engine belongs here rather than to the notebook, because it keeps the account rather
 * than a screen. Mounted one level above the tab switch it stays up while the reader moves between
 * containers, so a vault does not go quiet every time someone looks at another app.
 */
import { Suspense, lazy, type ComponentType } from 'react'
import { useSyncEngine } from '../../lib/sync'
import { usePathname } from '../../lib/app-history'
import { tabIdForPath, type AppTabId } from './app-tabs'
import { isTodoPath } from '../todos/todo-address'
import { AppRail } from './AppRail'
import { AppTabPlaceholder } from './AppTabPlaceholder'
import { AppShell } from './AppShell'
import { LoadingBlock } from '../../components/feedback'

/**
 * The reading app is lazy on purpose: it is the only container that pulls in a PDF engine, and a reader
 * who never opens the tab should not pay for it in the shell's own bytes.
 */
const ReadingApp = lazy(() => import('../reading/ReadingApp').then((m) => ({ default: m.ReadingApp })))
import { ChatApp } from '../chat/ChatApp'

/**
 * Which component answers for which tab. A tab the rail offers but this list does not name is a
 * container waiting for its app, and gets {@link AppTabPlaceholder}.
 *
 * An app that arrives by `lazy` is a deliberate second chunk: the reader who lives in the notebook
 * should not download the reader who reads feeds. The service worker's on-demand list has to know
 * the same thing, or the chunk joins every visitor's background warm-up.
 */
const CONTAINERS: Partial<Record<AppTabId, ComponentType>> = {
  notes: AppShell,
  memos: lazy(() => import('../memos/MemosApp').then((module) => ({ default: module.MemosApp }))),
  reading: ReadingApp,
  subscriptions: lazy(() => import('../subscriptions/SubscriptionsApp').then((module) => ({ default: module.SubscriptionsApp }))),
  todo: lazy(() => import('../todos/TodosApp').then((module) => ({ default: module.TodosApp }))),
  email: lazy(() => import('../email/EmailApp').then((module) => ({ default: module.EmailApp }))),
  rss: lazy(() => import('../rss/RssApp').then(module => ({ default: module.RssApp }))),
  music: lazy(() => import('../music/MusicApp').then((module) => ({ default: module.MusicApp }))),
  calendar: lazy(() => import('../calendar/CalendarApp').then((module) => ({ default: module.CalendarApp }))),
  chat: ChatApp,
  tools: lazy(() => import('../tools/ToolsApp').then((m) => ({ default: m.ToolsApp }))),
}

export function AppTabHost() {
  useSyncEngine()
  const pathname = usePathname()
  // A task's own screen is still the to-do app: the container that owns an address says so itself, because
  // the shape of `/todo/<task id>` belongs to it and not to the table of tab paths.
  const tabId = isTodoPath(pathname) ? 'todo' : tabIdForPath(pathname)
  const Container = CONTAINERS[tabId]
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--bg-base)]">
      <AppRail />
      {/* The column an app is drawn in, and the only container that is always there: it is where the caret
          lands when a dialog closes over a control that has left the document (`returnCaret` in
          `components/overlay.tsx`). Focusable, and left with its own ring — a reader who loses the row a
          dialog was opened from should see where they ended up. */}
      <div className="min-w-0 flex-1" data-app-frame="" tabIndex={-1}>
        {Container
          ? (
              <Suspense fallback={<LoadingBlock />}>
                <Container />
              </Suspense>
            )
          : <AppTabPlaceholder tabId={tabId} />}
      </div>
    </div>
  )
}
