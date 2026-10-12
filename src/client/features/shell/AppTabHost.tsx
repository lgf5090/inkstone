/**
 * The frame the app tabs live in: the rail on the left, one container on the right.
 *
 * The sync engine belongs here rather than to the notebook, because it keeps the account rather
 * than a screen. Mounted one level above the tab switch it stays up while the reader moves between
 * containers, so a vault does not go quiet every time someone looks at another app.
 */
import type { ComponentType } from 'react'
import { useSyncEngine } from '../../lib/sync'
import { usePathname } from '../../lib/app-history'
import { tabIdForPath, type AppTabId } from './app-tabs'
import { AppRail } from './AppRail'
import { AppTabPlaceholder } from './AppTabPlaceholder'
import { AppShell } from './AppShell'
import { ChatApp } from '../chat/ChatApp'

/**
 * Which component answers for which tab. A tab the rail offers but this list does not name is a
 * container waiting for its app, and gets {@link AppTabPlaceholder}.
 */
const CONTAINERS: Partial<Record<AppTabId, ComponentType>> = {
  notes: AppShell,
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
        {Container ? <Container /> : <AppTabPlaceholder tabId={tabId} />}
      </div>
    </div>
  )
}
