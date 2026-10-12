/**
 * The reader's keyboard, as data.
 *
 * The sheet and the handler read this one table, so a shortcut cannot be added to the keys and left
 * out of the help — the failure mode every reader app eventually ships.
 */
import type { MessageKey } from '../../../lib/i18n'

export type ReaderAction =
  | 'next' | 'prev' | 'first' | 'last'
  | 'toc' | 'search' | 'highlights' | 'marks' | 'appearance' | 'shortcuts' | 'stats'
  | 'mark' | 'prevHighlight' | 'nextHighlight'
  | 'fullscreen' | 'close'

export interface ShortcutEntry {
  /** The key this entry answers to, normalised to lower case for the matcher. */
  key: string
  /** What the sheet draws. */
  keys: string[]
  labelKey: MessageKey
  action: ReaderAction
  /** Panel toggles need to know which panel they are reopening. */
  panel?: 'toc' | 'search' | 'highlights' | 'marks' | 'appearance' | 'shortcuts' | 'stats'
}

export const READING_SHORTCUTS: ShortcutEntry[] = [
  { key: 'arrowright', keys: ['→'], action: 'next', labelKey: 'reading.next_page' },
  { key: 'arrowleft', keys: ['←'], action: 'prev', labelKey: 'reading.previous_page' },
  { key: ' ', keys: ['Space'], action: 'next', labelKey: 'reading.next_page' },
  { key: 'pagedown', keys: ['PgDn'], action: 'next', labelKey: 'reading.next_page' },
  { key: 'pageup', keys: ['PgUp'], action: 'prev', labelKey: 'reading.previous_page' },
  { key: 'home', keys: ['Home'], action: 'first', labelKey: 'reading.first_page' },
  { key: 'end', keys: ['End'], action: 'last', labelKey: 'reading.last_page' },
  { key: 'j', keys: ['J'], action: 'nextHighlight', labelKey: 'reading.next_highlight' },
  { key: 'k', keys: ['K'], action: 'prevHighlight', labelKey: 'reading.prev_highlight' },
  { key: 'm', keys: ['M'], action: 'mark', labelKey: 'reading.new_location_mark' },
  { key: 't', keys: ['T'], action: 'toc', panel: 'toc', labelKey: 'reading.contents' },
  { key: 's', keys: ['S'], action: 'search', panel: 'search', labelKey: 'reading.search_book' },
  { key: 'h', keys: ['H'], action: 'highlights', panel: 'highlights', labelKey: 'reading.highlights' },
  { key: 'b', keys: ['B'], action: 'marks', panel: 'marks', labelKey: 'reading.location_marks' },
  { key: 'i', keys: ['I'], action: 'appearance', panel: 'appearance', labelKey: 'reading.reading_settings' },
  { key: 'r', keys: ['R'], action: 'stats', panel: 'stats', labelKey: 'reading.stats_title' },
  { key: 'f', keys: ['F'], action: 'fullscreen', labelKey: 'reading.enter_fullscreen' },
  { key: '?', keys: ['?'], action: 'shortcuts', panel: 'shortcuts', labelKey: 'reading.shortcuts' },
  { key: 'escape', keys: ['Esc'], action: 'close', labelKey: 'reading.close_overlay' },
]

/** The keys that must keep working while a panel has focus, because they close it. */
const ALWAYS_ALLOWED = new Set(['escape', '?'])

export function shortcutFor(key: string): ShortcutEntry | null {
  const normalised = key.toLowerCase()
  return READING_SHORTCUTS.find((entry) => entry.key === normalised) ?? null
}

/**
 * Whether a keystroke still reaches the handler while a panel is open.
 *
 * A panel keeps its own keys, because the reader who opened the contents with T expects T to close it;
 * the others are held back so a letter typed into the panel's own field does not turn the page behind
 * it. Escape and the sheet answer to everything, since they are how the reader gets out.
 */
export function shortcutAllowedWhilePanelOpen(entry: ShortcutEntry, openPanel: ShortcutEntry['panel'] | null): boolean {
  return ALWAYS_ALLOWED.has(entry.key)
    || entry.action === 'close'
    || (entry.panel !== undefined && entry.panel === openPanel)
}
