/**
 * The address bar as the one source of truth for which app tab is up.
 *
 * The tab is a path rather than a store field so that a rail button is an ordinary link: the
 * address a reader copies is the screen they are looking at, the back button walks the tabs they
 * visited, and a cold load of `/calendar` needs nothing but the document the server already sends.
 * `history.pushState` fires no event of its own, so the writers here announce their own changes and
 * `popstate` covers everything the browser does by itself.
 */
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('popstate', emit)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('popstate', emit)
  }
}

export function currentPathname(): string {
  return window.location.pathname
}

/** Replace the address without a reload. A no-op on the address that is already up. */
export function navigateToPath(pathname: string): void {
  if (window.location.pathname === pathname) return
  window.history.pushState(null, '', pathname)
  emit()
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPathname)
}
