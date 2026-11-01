/**
 * Picking a colour off the screen.
 *
 * The studio's button and the command palette both need this, and only Chromium implements `EyeDropper`:
 * everywhere else the caller has to say so rather than appear to do nothing.
 */

interface EyeDropperApi {
  open: () => Promise<{ sRGBHex: string }>
}

declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperApi
  }
}

export function canPickFromScreen(): boolean {
  // The property can exist as `undefined` on a browser that never shipped the API, so ask for a constructor.
  return typeof window !== 'undefined' && typeof window.EyeDropper === 'function'
}

/**
 * The colour under the cursor, or null.
 *
 * Escape rejects the promise exactly the way a missing permission would; both answers are "no colour was
 * chosen", so the caller shows nothing rather than an error the reader did not ask about.
 */
export async function pickColorFromScreen(): Promise<string | null> {
  if (!canPickFromScreen() || !window.EyeDropper) return null
  try {
    const picked = await new window.EyeDropper().open()
    return picked?.sRGBHex ?? null
  } catch {
    return null
  }
}
