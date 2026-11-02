// Nav's own storage footprint, in a module small enough to import from the app shell.
//
// The sweep has to run while the session is being cleared, and sign-out navigates as soon as the event
// listeners have run: a handler that still needs to fetch a lazy chunk loses that race and leaves the
// bookmarks of a departed account on the machine. Only primitives live here, so the shell can hold it
// without pulling the navigation feature into the first paint.
const NAV_STORAGE_PREFIX = 'inkstone.nav.'

export function clearNavSessionStorage(): void {
  if (typeof window === 'undefined') return
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index)
      if (key?.startsWith(`${NAV_STORAGE_PREFIX}unlocks.`)) window.sessionStorage.removeItem(key)
    }
    // The check cache is, in effect, a list of the reader's bookmarks with the address each one finally
    // landed on. It exists to save a rescan, not to keep a record, so it goes with the session — the
    // departed account's copy included, which nobody is left to read it.
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(NAV_STORAGE_PREFIX)) window.localStorage.removeItem(key)
    }
  } catch {
    // Private mode or a blocked store: there is nothing left we can do about the bytes, and the
    // in-memory state the caller clears still does its job.
  }
}
