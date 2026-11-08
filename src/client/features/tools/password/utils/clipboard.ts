/** How long a copied secret is allowed to sit on the clipboard. */
export const CLIPBOARD_CLEAR_MS = 30_000

let clearTimer: ReturnType<typeof setTimeout> | null = null
/** The secret this module last put on the clipboard, so it can be wiped on lock. */
let lastSecret: string | null = null

/**
 * Copies a secret and clears it again after a delay.
 *
 * The value is only wiped when the clipboard still holds it: the reader may have copied something
 * else in the meantime, and clearing that would be its own surprise. Reading the clipboard needs a
 * permission the browser can refuse outside a gesture, so the clean-up is best effort — the copy
 * itself has already succeeded and a failed wipe must not look like a failed copy.
 */
export async function copySecret(text: string, delayMs = CLIPBOARD_CLEAR_MS): Promise<void> {
  await navigator.clipboard.writeText(text)
  lastSecret = text

  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    lastSecret = null
    void navigator.clipboard
      .readText()
      .then((current) => (current === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => {
        // No permission to read back: leave the clipboard alone rather than risk wiping a value the
        // reader copied elsewhere.
      })
  }, delayMs)
}

/**
 * Wipes the clipboard if it still holds the secret this module copied.
 *
 * Called when the vault locks or the page goes away: the 30-second timer already covers the normal
 * case, but a lock or a closed tab must not leave a password for the next person at the machine.
 */
export function clearClipboardSecret(): void {
  if (clearTimer) {
    clearTimeout(clearTimer)
    clearTimer = null
  }
  const secret = lastSecret
  lastSecret = null
  if (secret === null || typeof navigator === 'undefined' || !navigator.clipboard) return

  void navigator.clipboard
    .readText()
    .then((current) => (current === secret ? navigator.clipboard.writeText('') : undefined))
    .catch(() => {
      // Same reasoning as above: no read permission means no safe way to tell what to wipe.
    })
}

