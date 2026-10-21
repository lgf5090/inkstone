/**
 * The one request the Templater chooser answers to.
 *
 * A command cannot render a dialog by itself, so this module holds the ask and the mounted host answers it
 * — the same shape the app already uses twice: {@link prompt} and {@link confirm} in
 * `components/overlay.tsx`, and `requestPropertyDecoration` in `lib/property-commands.ts`. A module-level
 * signal rather than a `PanelName` because the chooser is a run of the engine, not a place in the shell,
 * and because adding a panel would mean widening a union the whole shell switches on.
 *
 * The host marks itself while it is mounted, which is what makes the second half of
 * {@link openTemplaterPicker} honest: with no chooser on screen the command brings up the surface that
 * hosts it (the template gallery) rather than setting state nobody will read. That is the same contract
 * `confirm()` states outright: with no host there is no dialog, and saying so beats silence.
 */
import { useUi } from '../../store/ui'

export type TemplaterPickerMode = 'insert' | 'create' | 'replace'

export interface TemplaterPickerRequest {
  mode: TemplaterPickerMode
}

type Listener = (request: TemplaterPickerRequest | null) => void

let current: TemplaterPickerRequest | null = null
let mountedHosts = 0
/** Whether opening this request had to bring the gallery up, so closing it can put that back down. */
let openedGalleryFor = false
const listeners = new Set<Listener>

function notify(): void {
  // Copied first: a listener that unsubscribes while being called must not shift the set being walked.
  for (const listener of [...listeners]) listener(current)
}

/**
 * Called by the chooser's host while it is on screen.
 *
 * A counter rather than a flag, because the gallery and — once the shell mounts it — `AppShell`'s overlay
 * host can both be up; whichever leaves must not make the other's presence unreported.
 */
export function attachTemplaterPickerHost(): () => void {
  mountedHosts += 1
  notify()
  return () => {
    mountedHosts = Math.max(0, mountedHosts - 1)
    notify()
  }
}

export function subscribeTemplaterPicker(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function peekTemplaterPicker(): TemplaterPickerRequest | null {
  return current
}

export function closeTemplaterPicker(): void {
  if (current === null) return
  current = null
  notify()
  // The gallery was raised only to host the chooser, so it goes back down with it — unless the reader
  // opened the library again in the meantime, which is their own navigation and stays.
  if (openedGalleryFor) {
    openedGalleryFor = false
    if (useUi.getState().panel === 'templates') useUi.getState().closePanel()
  }
}

/**
 * Ask for the chooser, and make sure something is there to show it.
 *
 * Returns whether a host was already listening, which is the only way a caller can tell that a dialog is
 * appearing now rather than after a panel switch. The request itself is stored either way: a host that
 * mounts in the next frame adopts it, which is what keeps the gallery route from losing the reader's press.
 */
export function openTemplaterPicker(mode: TemplaterPickerMode): boolean {
  current = { mode }
  notify()
  if (mountedHosts > 0) return true
  openedGalleryFor = true
  useUi.getState().openPanel('templates')
  return false
}
