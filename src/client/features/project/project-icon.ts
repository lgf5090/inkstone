/**
 * A-9/A-10: board & card icons. The random-icon preference is a local toggle; when on, newly created
 * boards/cards get a random emoji from the shared catalog so lists stay scannable without manual picking.
 */
import { loadEmojiCatalog } from '../../lib/emoji-catalog'

const PREF_KEY = 'inkstone.project.randomIcon'

export function readRandomIconPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1'
  } catch { /* best-effort: the preference is optional */
    return false
  }
}

export function writeRandomIconPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0')
  } catch { /* best-effort: the preference is optional */
  }
}

export async function randomProjectIcon(): Promise<string> {
  const catalog = await loadEmojiCatalog()
  const entries = catalog.EMOJI_ICON_ENTRIES
  const pick = entries[Math.floor(Math.random() * entries.length)]
  return pick?.char ?? '📋'
}