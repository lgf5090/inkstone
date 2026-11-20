/**
 * The chat's keystrokes, written down once.
 *
 * These chords used to live inside whichever handler answered them, so the shortcut overview could only
 * have been fed a second, hand-copied list — and a list copied by hand is the thing that quietly stops
 * being true. Every entry here is read by both halves: the view matches a keystroke against the name it
 * is filed under, and the overview prints the same string. One table, one place to change.
 *
 * A reader may rebind a chord in settings. The override is never written back into this table: the
 * built-ins stay the honest default, and {@link resolvedCombo} is the one place that decides which
 * chord is in force, so handlers, the overview and the editor cannot disagree about a rebind.
 */
import type { AssistantShortcutName, AssistantShortcuts } from '@shared/assistant'
import { matches } from '../../lib/hotkeys'
import { t } from '../../lib/i18n'

export const CHAT_SHORTCUTS = {
  /** Opens find-in-thread over the thread on screen, instead of the browser's own bar. */
  find: 'mod+f',
  /** The composer's way out of a reply that is taking too long. */
  stop: 'escape',
  /** The same key with its other meaning: it takes the find panel, and the `@`/`#`/`/` panel, back out. */
  closePanel: 'escape',
  /** The chord that asks the question. Which of the two it is follows the reader's own setting. */
  send: 'enter',
  newLine: 'shift+enter',
  /** The inline picker's rows: asked for by `@`, `#` and `/`, answered by the composer's own handler. */
  pickerPrevious: 'arrowup',
  pickerNext: 'arrowdown',
  pickerPick: 'enter',
  pickerPickAlternate: 'tab',
} as const

/** One row of the overview: the chord, and the words that say what it does. */
export interface ChatShortcutEntry {
  combo: string
  description: () => string
}

/** The overview's rows in the order a reader learns them, each filed under the action it belongs to. */
const PANEL_ROWS: ReadonlyArray<{ name: keyof typeof CHAT_SHORTCUTS, description: () => string }> = [
  { name: 'find', description: () => t('assistant.chat.find') },
  { name: 'stop', description: () => t('assistant.chat.stop') },
  { name: 'closePanel', description: () => t('command.close_overlay') },
  { name: 'send', description: () => t('assistant.chat.send') },
  { name: 'newLine', description: () => t('command.chat_new_line') },
  { name: 'pickerPrevious', description: () => t('command.navigate_menu') },
  { name: 'pickerNext', description: () => t('command.navigate_menu') },
  { name: 'pickerPick', description: () => t('command.confirm_choice') },
  { name: 'pickerPickAlternate', description: () => t('command.confirm_choice') },
]

/**
 * The chord an action answers to right now: the reader's override when one is set, otherwise the
 * built-in. Only chords `normalizeShortcuts` accepted can reach here, so a rebind is always a combo
 * `matches` understands.
 */
export function resolvedCombo(name: keyof typeof CHAT_SHORTCUTS, shortcuts?: AssistantShortcuts): string {
  return shortcuts?.[name as AssistantShortcutName] ?? CHAT_SHORTCUTS[name]
}

/** What the command palette prints: the built-in chords, as an array for that caller. */
export const CHAT_SHORTCUT_PANEL: ChatShortcutEntry[] = PANEL_ROWS.map((row) => ({
  combo: CHAT_SHORTCUTS[row.name],
  description: row.description,
}))

/** The same overview with the chords currently in force, for the settings page. */
export function chatShortcutPanel(shortcuts?: AssistantShortcuts): ChatShortcutEntry[] {
  return PANEL_ROWS.map((row) => ({
    combo: resolvedCombo(row.name, shortcuts),
    description: row.description,
  }))
}

/**
 * Whether a keystroke is the chord this table names.
 *
 * The input-method guard is the caller's, not this function's: a candidate's arrows and Enter belong to
 * the method composing them, and every handler that asks here answers that first. A caller that has the
 * reader's settings passes them so a rebind is matched; one that has none falls back to the built-in.
 */
export function isChatShortcut(event: KeyboardEvent, name: keyof typeof CHAT_SHORTCUTS, shortcuts?: AssistantShortcuts): boolean {
  return matches(event, resolvedCombo(name, shortcuts))
}
