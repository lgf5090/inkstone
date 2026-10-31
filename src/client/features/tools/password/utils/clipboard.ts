/** How long a copied secret is allowed to sit on the clipboard. */
export const CLIPBOARD_CLEAR_MS = 30_000

let clearTimer: ReturnType<typeof setTimeout> | null = null

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

  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    void navigator.clipboard
      .readText()
      .then((current) => (current === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => {
        // No permission to read back: leave the clipboard alone rather than risk wiping a value the
        // reader copied elsewhere.
      })
  }, delayMs)
}
