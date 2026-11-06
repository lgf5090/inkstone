/**
 * Which terminal-local action a keydown means. Kept apart from the xterm hook so the mapping can be
 * tested without a canvas, and so the shortcut dialog and the handler cannot drift apart.
 *
 * Ctrl+C stays SIGINT: copying is Ctrl+Shift+C, exactly as it is in a desktop terminal. The
 * platform modifier (Cmd on macOS, Ctrl elsewhere) is accepted for both.
 */
export type TerminalShortcutAction = 'copy' | 'paste' | 'clear'

export function terminalShortcutAction(event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): TerminalShortcutAction | null {
  if (event.type !== 'keydown') return null
  if (event.altKey) return null
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return null
  const key = event.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  if (key === 'k') return 'clear'
  return null
}
