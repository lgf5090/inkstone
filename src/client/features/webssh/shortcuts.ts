/**
 * Every terminal-local key, in one table.
 *
 * The xterm handler and the help dialog read the same definitions, so a shortcut cannot work while the
 * dialog describes an older one. `shortcutConflicts` is the second reader: it answers which combinations
 * two actions claim at once, which is what keeps a future addition from silently shadowing a copy or a
 * search. Terminal keys stay on the platform modifier plus Shift because plain Ctrl+C has to remain
 * SIGINT, and Alt is never claimed here — it is a terminal modifier the shell receives.
 */
import type { MessageKey } from '@shared/locales/en-US'

export type TerminalShortcutAction = 'copy' | 'paste' | 'clear' | 'search' | 'fullscreen'

export type TerminalShortcutId =
  | TerminalShortcutAction
  | 'search_next'
  | 'search_previous'
  | 'close_search'
  | 'command_send'

export interface TerminalShortcutDefinition {
  id: TerminalShortcutId
  labelKey: MessageKey
  /** A combination `Kbd` understands, e.g. `mod+shift+c`; absent for keys read inside a field. */
  combo?: string
  /** A key chord drawn as separate caps, for the keys a focused search field owns. */
  keys?: readonly string[]
}

export const TERMINAL_SHORTCUTS: readonly TerminalShortcutDefinition[] = [
  { id: 'copy', labelKey: 'webssh.shortcuts.copy', combo: 'mod+shift+c' },
  { id: 'paste', labelKey: 'webssh.shortcuts.paste', combo: 'mod+shift+v' },
  { id: 'clear', labelKey: 'webssh.shortcuts.clear', combo: 'mod+shift+k' },
  { id: 'search', labelKey: 'webssh.shortcuts.search', combo: 'mod+f' },
  { id: 'search_next', labelKey: 'webssh.shortcuts.search_next', combo: 'enter' },
  { id: 'search_previous', labelKey: 'webssh.shortcuts.search_previous', combo: 'shift+enter' },
  { id: 'fullscreen', labelKey: 'webssh.shortcuts.fullscreen', combo: 'mod+shift+f' },
  { id: 'command_send', labelKey: 'webssh.shortcuts.command_send', combo: 'mod+enter' },
  { id: 'close_search', labelKey: 'webssh.shortcuts.close_search', keys: ['Esc'] },
]

/** Combos are compared as modifier sets plus a key, so `shift+mod+f` cannot hide behind `mod+shift+f`. */
export function normalizeShortcutCombo(combo: string): string {
  const parts = combo.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const modifiers = [...new Set(parts)].sort()
  return [...modifiers, key].join('+')
}

export function shortcutConflicts(
  definitions: readonly Pick<TerminalShortcutDefinition, 'id' | 'combo'>[] = TERMINAL_SHORTCUTS,
): string[] {
  const owners = new Map<string, string[]>()
  for (const definition of definitions) {
    if (!definition.combo) continue
    const combo = normalizeShortcutCombo(definition.combo)
    const ids = owners.get(combo) ?? []
    ids.push(definition.id)
    owners.set(combo, ids)
  }
  return [...owners.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([combo, ids]) => `${combo}: ${ids.join(', ')}`)
}

export function terminalShortcutAction(event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): TerminalShortcutAction | null {
  if (event.type !== 'keydown') return null
  if (event.altKey) return null
  if (!(event.ctrlKey || event.metaKey)) return null
  const key = event.key.toLowerCase()
  if (event.shiftKey) {
    if (key === 'c') return 'copy'
    if (key === 'v') return 'paste'
    if (key === 'k') return 'clear'
    if (key === 'f') return 'fullscreen'
    return null
  }
  if (key === 'f') return 'search'
  return null
}
