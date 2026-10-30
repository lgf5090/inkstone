// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isSendShortcut } from '../src/client/features/development/api-tester/lib/shortcut'

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init })
}

describe('API Tester send shortcut', () => {
  it('answers Ctrl+Enter and Cmd+Enter', () => {
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true)
  })

  it('ignores a bare Enter, another key, and an IME frame', () => {
    expect(isSendShortcut(key({}))).toBe(false)
    // Shift is not a modifier this module assigns, so Ctrl/Cmd+Shift+Enter still means send.
    expect(isSendShortcut(key({ shiftKey: true, ctrlKey: true }))).toBe(true)
    expect(isSendShortcut(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))).toBe(false)
    expect(isSendShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false)
  })

  it('leaves a keystroke another handler already answered alone', () => {
    const event = key({ ctrlKey: true })
    event.preventDefault()
    expect(isSendShortcut(event)).toBe(false)
  })
})
