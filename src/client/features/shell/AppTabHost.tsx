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
  rss: lazy(() => import('../rss/RssApp').then(module => ({ default: module.RssApp }))),
  chat: ChatApp,
}

export function AppTabHost() {
  useSyncEngine()
  const tabId = tabIdForPath(usePathname())
  const Container = CONTAINERS[tabId]
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--bg-base)]">
      <AppRail />
      <div className="min-w-0 flex-1">
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
