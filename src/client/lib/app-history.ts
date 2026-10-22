/**
 * The address bar as the one source of truth for what the reader is looking at.
 *
 * The tab is a path rather than a store field so that a rail button is an ordinary link: the
 * address a reader copies is the screen they are looking at, the back button walks the tabs they
 * visited, and a cold load of `/calendar` needs nothing but the document the server already sends.
 * A container's own state — which view of it is up, what it is filtered to — is the query on that
 * path, and the one screen of it is the sub-path, for the same reason: an address that says
 * `/todo?view=plan&q=tax` can be pasted into a chat, and an address that says nothing is a screen
 * nobody else can reach.
 *
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

/** The query as the browser holds it: empty, or leading with `?`. */
export function currentSearch(): string {
  return window.location.search
}

/** `pushState` and `replaceState` both leave the reader where they were, so both have to announce it. */
function writeState(address: string, push: boolean): void {
  if (`${window.location.pathname}${window.location.search}` === address) return
  if (push) window.history.pushState(null, '', address)
  else window.history.replaceState(null, '', address)
  emit()
}

/**
 * Push an address, naming a screen rather than leaving one.
 *
 * A pushed entry is the promise that the back button goes somewhere the reader actually stood, so it is
 * for the state that changes on a deliberate move: a tab, a view, a screen. `search` is the query without
 * its leading `?`.
 */
export function navigateToAddress(pathname: string, search = ''): void {
  writeState(`${pathname}${search ? `?${search}` : ''}`, true)
}

/**
 * Change the address without giving the reader another back button.
 *
 * For state that moves as fast as they type: a search box that pushed would turn three keystrokes into
 * three presses of back, and a reader who returns to the app lands on a screen they never chose.
 */
export function replaceAddress(pathname: string, search = ''): void {
  writeState(`${pathname}${search ? `?${search}` : ''}`, false)
}

/** Replace the address without a reload. A no-op on the address that is already up. */
export function navigateToPath(pathname: string): void {
  navigateToAddress(pathname, '')
}

/** Listen for the address changing by anything other than the reader leaving the page. */
export function subscribeToAddress(listener: () => void): () => void {
  return subscribe(listener)
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPathname)
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch)
}
