/**
 * The frame the app tabs live in: the rail on the left, one container on the right.
 *
 * The sync engine belongs here rather than to the notebook, because it keeps the account rather
 * than a screen. Mounted one level above the tab switch it stays up while the reader moves between
 * containers, so a vault does not go quiet every time someone looks at another app.
 */
import { lazy, Suspense, type ComponentType } from 'react'
import { useSyncEngine } from '../../lib/sync'
import { usePathname } from '../../lib/app-history'
import { tabIdForPath, type AppTabId } from './app-tabs'
import { AppRail } from './AppRail'
import { AppTabPlaceholder } from './AppTabPlaceholder'
import { AppShell } from './AppShell'

/**
 * The reading app is lazy on purpose: it is the only container that pulls in a PDF engine, and a reader
 * who never opens the tab should not pay for it in the shell's own bytes.
 */
const ReadingApp = lazy(() => import('../reading/ReadingApp').then((m) => ({ default: m.ReadingApp })))

/**
 * Which component answers for which tab. A tab the rail offers but this list does not name is a
 * container waiting for its app, and gets {@link AppTabPlaceholder}.
 */
const CONTAINERS: Partial<Record<AppTabId, ComponentType>> = {
  notes: AppShell,
  reading: ReadingApp,
}

export function AppTabHost() {
  useSyncEngine()
  const tabId = tabIdForPath(usePathname())
  const Container = CONTAINERS[tabId]
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--bg-base)]">
      <AppRail />
      <div className="min-w-0 flex-1">
        {Container ? (
          <Suspense fallback={<div className="h-full bg-[var(--bg-base)]" />}>
            <Container />
          </Suspense>
        ) : (
          <AppTabPlaceholder tabId={tabId} />
        )}
      </div>
    </div>
  )
}
