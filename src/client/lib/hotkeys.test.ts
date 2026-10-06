import { afterEach, describe, expect, it, vi } from 'vitest'
import { IS_MAC, isEditableTarget, matches, prettyCombo, register } from './hotkeys'
import { APP_SHORTCUTS } from './shortcuts'

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})

function listen(combo: string, options: Partial<Parameters<typeof register>[0]> = {}) {
  const handler = vi.fn()
  disposers.push(register({ id: combo, combo, description: '', group: '', handler, ...options }))
  return handler
}

function press(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('hotkey matching and display', () => {
  it('requires exact modifiers for punctuation so layout cycling does not steal matching-bracket navigation', () => {
    expect(matches(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', ctrlKey: true }), 'mod+\\', false)).toBe(true)
    expect(matches(new KeyboardEvent('keydown', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }), 'mod+\\', false)).toBe(false)
    expect(matches(new KeyboardEvent('keydown', { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }), 'mod+shift+/', false)).toBe(true)
  })

  it('matches the physical key when Option or Shift changes the typed character', () => {
    expect(matches(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', ctrlKey: true, altKey: true }), 'mod+alt+1', false)).toBe(true)
    expect(matches(new KeyboardEvent('keydown', { key: '\u00a1', code: 'Digit1', metaKey: true, altKey: true }), 'mod+alt+1', true)).toBe(true)
    expect(matches(new KeyboardEvent('keydown', { key: '*', code: 'Digit8', metaKey: true, shiftKey: true }), 'mod+shift+8', true)).toBe(true)
  })

  it('uses platform-specific labels including physical punctuation keys', () => {
    expect(prettyCombo('mod+alt+1', false)).toEqual(['Ctrl', 'Alt', '1'])
    expect(prettyCombo('mod+alt+1', true)).toEqual(['\u2318', '\u2325', '1'])
    expect(prettyCombo('mod+shift+/', false)).toEqual(['Ctrl', 'Shift', '/'])
  })

  it('ignores repeat and IME composition without consuming the event', () => {
    const handler = listen('mod+s', { allowInInput: true })
    const modifiers = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    expect(press(window, { key: 's', repeat: true, ...modifiers }).defaultPrevented).toBe(false)
    expect(press(window, { key: 's', isComposing: true, ...modifiers }).defaultPrevented).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(press(window, { key: 's', ...modifiers }).defaultPrevented).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not execute disabled or background actions from a menu or dialog', () => {
    const handler = listen('mod+alt+s', { allowInInput: true })
    const modifiers = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    expect(press(dialog, { key: 's', altKey: true, ...modifiers }).defaultPrevented).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    dialog.remove()
    const disabled = listen('mod+alt+n', { enabled: () => false })
    expect(press(window, { key: 'n', altKey: true, ...modifiers }).defaultPrevented).toBe(false)
    expect(disabled).not.toHaveBeenCalled()
  })

  it('recognizes nested contenteditable targets and leaves text input to local handlers', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    document.body.append(editable)
    expect(isEditableTarget(child)).toBe(true)
    const handler = listen('delete')
    expect(press(child, { key: 'Delete' }).defaultPrevented).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('opens and closes the graph from an editor or an open dialog', () => {
    const handler = listen(APP_SHORTCUTS.graph, { allowInInput: true, allowInOverlay: true })
    const modifiers = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    const editor = document.createElement('textarea')
    document.body.append(editor)
    expect(press(editor, { key: 'g', shiftKey: true, ...modifiers }).defaultPrevented).toBe(true)
    editor.remove()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    expect(press(dialog, { key: 'G', shiftKey: true, ...modifiers }).defaultPrevented).toBe(true)
    dialog.remove()
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('gives every app shortcut its own chord', () => {
    const chords = Object.entries(APP_SHORTCUTS)
    const seen = new Map<string, string>()
    for (const [name, chord] of chords) {
      const clash = seen.get(chord)
      expect(clash, `${name} and ${clash} both bind ${chord}`).toBeUndefined()
      seen.set(chord, name)
    }
    expect(APP_SHORTCUTS.graph).toBe('mod+shift+g')
  })
})
