import { describe, expect, it } from 'vitest'
import { terminalShortcutAction } from '../src/client/features/webssh/shortcuts'

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
})
