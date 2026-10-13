/**
 * A screen of the reader, asked for from outside it.
 *
 * The palette, a hotkey and an automation step all live in the notebook container, and this reader
 * only exists at `/rss` — a lazy chunk that is not even mounted while the reader is somewhere else.
 * So an ask cannot be a prop or a callback: it is parked here, the address changes, and the reader
 * takes it as it mounts. Taking clears it, which is why the back button and a second visit land on
 * the article rather than reopening the same dialog for ever.
 */
import { navigateToPath } from '../../lib/app-history'
import { appTab } from '../shell/app-tabs'

export type RssSection = 'reader' | 'manage' | 'add' | 'discover' | 'health'

let pending: RssSection | null = null

/** Go to the reader, and show this part of it once it is up. */
export function openRssSection(section: RssSection): void {
  pending = section
  navigateToPath(appTab('rss').path)
}

/** The section asked for and not yet shown, or null. Reading it consumes it. */
export function takeRssSection(): RssSection | null {
  const asked = pending
  pending = null
  return asked
}
