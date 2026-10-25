/**
 * Local music preferences and queue snapshots belong to the account that wrote them.
 *
 * Logout reloads the document, so in-memory stores disappear; these keys would otherwise survive
 * into the next account on the same browser. A prefix sweep is deliberately broader than the
 * current key list so a new music preference cannot quietly outlive a session.
 */
const MUSIC_STORAGE_PREFIXES = ['inkstone.music.', 'inkstone.demo.music.'] as const

export function clearMusicSessionStorage(): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && MUSIC_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch (error) {
    console.warn('[inkstone] Music local preferences could not be cleared:', error)
  }
}

export function onSessionCleared(handler: () => void): () => void {
  const listener = (): void => handler()
  window.addEventListener('inkstone:session-cleared', listener)
  return () => window.removeEventListener('inkstone:session-cleared', listener)
}
