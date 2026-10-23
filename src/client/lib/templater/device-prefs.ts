/**
 * The templater switches that belong to one device rather than to one account.
 *
 * Upstream marks three of its settings local (`LocalSettings.ts`): the file-creation trigger and the startup
 * templates, plus a system-command switch this app does not have. The reason is worth keeping, because it is
 * not tidiness — these two decide *whether a template runs when nobody asked*. A setting that syncs would let
 * a reader flip the switch on their phone in a café and have their desktop start running templates over every
 * note they create there, months later, with nothing on the desktop's screen saying who decided that.
 *
 * They are keyed by user id for the same reason in the other direction: one device shared by two accounts
 * must not have one account's "yes, run templates on new files" answer applied to the other's notes.
 */
import { useSyncExternalStore } from 'react'

/** The two answers this device holds, per account. */
export interface TemplaterDevicePrefs {
  /** Run the folder/pattern trigger over a note the reader just created. */
  triggerOnFileCreation: boolean
  /** Run the reader's startup templates once, after the library has finished loading. */
  enableStartupTemplates: boolean
}

export const TEMPLATER_DEVICE_PREFS_PREFIX = 'inkstone:templater:device-prefs'

/**
 * The conservative answer: neither switch is on until this device is told otherwise.
 *
 * One object, not a fresh one per call. `useTemplaterDevicePrefs` hands it to `useSyncExternalStore` as its
 * snapshot, and a snapshot whose identity changes on every read is an infinite render loop — measured, not
 * theorised: the first version of this module allocated here and React failed the tree with
 * "Maximum update depth exceeded". Nothing mutates a prefs object in place; a write builds a new one.
 */
const DEFAULT_PREFS: TemplaterDevicePrefs = Object.freeze({
  triggerOnFileCreation: false,
  enableStartupTemplates: false,
})

export function defaultTemplaterDevicePrefs(): TemplaterDevicePrefs {
  return DEFAULT_PREFS
}

export function templaterDevicePrefsKey(userId: string): string {
  return `${TEMPLATER_DEVICE_PREFS_PREFIX}:${userId}`
}

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/**
 * The remembered answers, or the defaults.
 *
 * A row that cannot be read is not an error to report: it is this device having never been asked, which is
 * what the defaults say. Only the two known booleans are read, so a device that once stored a third name
 * under this key keeps its other settings intact and answers the defaults here.
 */
export function loadTemplaterDevicePrefs(userId: string): TemplaterDevicePrefs {
  const storage = readStorage()
  if (storage === null || userId === '') return defaultTemplaterDevicePrefs()
  try {
    const raw = storage.getItem(templaterDevicePrefsKey(userId))
    if (raw === null) return defaultTemplaterDevicePrefs()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaultTemplaterDevicePrefs()
    const row = parsed as Record<string, unknown>
    return {
      triggerOnFileCreation: typeof row.triggerOnFileCreation === 'boolean'
        ? row.triggerOnFileCreation
        : defaultTemplaterDevicePrefs().triggerOnFileCreation,
      enableStartupTemplates: typeof row.enableStartupTemplates === 'boolean'
        ? row.enableStartupTemplates
        : defaultTemplaterDevicePrefs().enableStartupTemplates,
    }
  }
  catch {
    return defaultTemplaterDevicePrefs()
  }
}

/** One cache per account on this device, so two signed-in tabs do not read each other's answers. */
const cache = new Map<string, TemplaterDevicePrefs>()
const listeners = new Set<() => void>()

function cached(userId: string): TemplaterDevicePrefs {
  const known = cache.get(userId)
  if (known !== undefined) return known
  const loaded = loadTemplaterDevicePrefs(userId)
  cache.set(userId, loaded)
  return loaded
}

/**
 * Change one answer and put it on disk.
 *
 * The write is best-effort and the in-memory answer changes either way: a device with storage full or
 * blocked still has to behave the way its screen says it does for the rest of this session, and the loss is
 * that the next load falls back to "off" — the safe direction, and the one that needs no explanation to the
 * reader because it is the answer they started with.
 */
export function setTemplaterDevicePrefs(userId: string, patch: Partial<TemplaterDevicePrefs>): TemplaterDevicePrefs {
  const next = { ...cached(userId), ...patch }
  cache.set(userId, next)
  const storage = readStorage()
  if (storage !== null && userId !== '') {
    try {
      storage.setItem(templaterDevicePrefsKey(userId), JSON.stringify(next))
    }
    catch {
      // Persistence only; see above.
    }
  }
  for (const listener of [...listeners]) listener()
  return next
}

/** Forget one account's answers — the sign-out path, so the next reader of this device is not inheriting them. */
export function clearTemplaterDevicePrefs(userId: string): void {
  if (!cache.delete(userId)) return
  for (const listener of [...listeners]) listener()
}

/**
 * The answers for one account, as a React store.
 *
 * `getSnapshot` returns the cached object, which is stable until a write replaces it — that stability is what
 * keeps `useSyncExternalStore` from re-rendering the settings panel on every keystroke elsewhere.
 */
export function useTemplaterDevicePrefs(userId: string | null | undefined): TemplaterDevicePrefs {
  return useSyncExternalStore(
    (subscribe) => {
      listeners.add(subscribe)
      return () => listeners.delete(subscribe)
    },
    () => (userId ? cached(userId) : defaultTemplaterDevicePrefs()),
    () => defaultTemplaterDevicePrefs(),
  )
}
