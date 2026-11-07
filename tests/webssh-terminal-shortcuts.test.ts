import { describe, expect, it } from 'vitest'
import { TERMINAL_SHORTCUTS, shortcutConflicts, terminalShortcutAction } from '../src/client/features/webssh/shortcuts'

function keydown(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent
}

describe('terminal shortcuts', () => {
  it('maps mod+shift+C, mod+shift+V and mod+shift+K', () => {
    expect(terminalShortcutAction(keydown({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe('copy')
    expect(terminalShortcutAction(keydown({ key: 'v', metaKey: true, shiftKey: true }))).toBe('paste')
    expect(terminalShortcutAction(keydown({ key: 'k', ctrlKey: true, shiftKey: true }))).toBe('clear')
  })

  it('leaves Ctrl+C alone so it still sends SIGINT', () => {
    expect(terminalShortcutAction(keydown({ key: 'c', ctrlKey: true }))).toBeNull()
    expect(terminalShortcutAction(keydown({ key: 'v', ctrlKey: true }))).toBeNull()
  })

  it('ignores Alt combinations, keyup and other letters', () => {
    expect(terminalShortcutAction(keydown({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
    expect(terminalShortcutAction({ ...keydown({ key: 'c', ctrlKey: true, shiftKey: true }), type: 'keyup' } as KeyboardEvent)).toBeNull()
    expect(terminalShortcutAction(keydown({ key: 'x', ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('opens search and full screen without claiming Ctrl+Enter', () => {
    expect(terminalShortcutAction(keydown({ key: 'f', ctrlKey: true }))).toBe('search')
    expect(terminalShortcutAction(keydown({ key: 'f', metaKey: true }))).toBe('search')
    expect(terminalShortcutAction(keydown({ key: 'f', ctrlKey: true, shiftKey: true }))).toBe('fullscreen')
    expect(terminalShortcutAction(keydown({ key: 'Enter', ctrlKey: true }))).toBeNull()
  })

  it('has no two actions claiming the same combination', () => {
    expect(shortcutConflicts()).toEqual([])
  })

  it('finds a conflict even when the modifiers are written in another order', () => {
    expect(shortcutConflicts([
      { id: 'copy', combo: 'mod+shift+f' },
      { id: 'fullscreen', combo: 'shift+mod+f' },
    ])).toEqual(['mod+shift+f: copy, fullscreen'])
    expect(TERMINAL_SHORTCUTS.every((shortcut) => shortcut.combo || shortcut.keys)).toBe(true)
  })
})
