/**
 * The chat's keystrokes, written down once.
 *
 * These chords used to live inside whichever handler answered them, so the shortcut overview could only
 * have been fed a second, hand-copied list — and a list copied by hand is the thing that quietly stops
 * being true. Every entry here is read by both halves: the view matches a keystroke against the name it
 * is filed under, and the overview prints the same string. One table, one place to change.
 *
 * There is no binding editor, so a combo here is not editable: it is the description of what the code
 * already answers to, which is exactly what the panel needs instead of inventing its own.
 */
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

/** What the shortcut overview draws under the chat group, in the order a reader learns it. */
export const CHAT_SHORTCUT_PANEL: ChatShortcutEntry[] = [
  { combo: CHAT_SHORTCUTS.find, description: () => t('assistant.chat.find') },
  { combo: CHAT_SHORTCUTS.stop, description: () => t('assistant.chat.stop') },
  { combo: CHAT_SHORTCUTS.closePanel, description: () => t('command.close_overlay') },
  { combo: CHAT_SHORTCUTS.send, description: () => t('assistant.chat.send') },
  { combo: CHAT_SHORTCUTS.newLine, description: () => t('command.chat_new_line') },
  { combo: CHAT_SHORTCUTS.pickerPrevious, description: () => t('command.navigate_menu') },
  { combo: CHAT_SHORTCUTS.pickerNext, description: () => t('command.navigate_menu') },
  { combo: CHAT_SHORTCUTS.pickerPick, description: () => t('command.confirm_choice') },
  { combo: CHAT_SHORTCUTS.pickerPickAlternate, description: () => t('command.confirm_choice') },
]

/**
 * Whether a keystroke is the chord this table names.
 *
 * The input-method guard is the caller's, not this function's: a candidate's arrows and Enter belong to
 * the method composing them, and every handler that asks here answers that first.
 */
export function isChatShortcut(event: KeyboardEvent, name: keyof typeof CHAT_SHORTCUTS): boolean {
  return matches(event, CHAT_SHORTCUTS[name])
}
