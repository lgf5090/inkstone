/**
 * The chording behind a column's title field (KU-13): `Enter` files the title, `Shift+Enter` files it and
 * opens the card, `Escape` puts the field away, and every other key is the reader typing — which is what
 * `null` means, and the reason it is not the same as `dismiss`.
 */
import { describe, expect, it } from 'vitest'
import { kanbanQuickAddCommand } from './quick-add'

describe('the column title field answers two chords', () => {
  it('files the title on Enter, without opening the card', () => {
    expect(kanbanQuickAddCommand('Enter', false)).toEqual({ kind: 'file', openDetail: false })
  })

  it('files the title and opens the card on Shift+Enter', () => {
    expect(kanbanQuickAddCommand('Enter', true)).toEqual({ kind: 'file', openDetail: true })
  })

  it('puts the field away on Escape', () => {
    expect(kanbanQuickAddCommand('Escape', false)).toEqual({ kind: 'dismiss' })
    expect(kanbanQuickAddCommand('Escape', true)).toEqual({ kind: 'dismiss' })
  })
})

describe('every other key is the reader typing', () => {
  it('answers nothing for letters, spaces and the keys that edit the field', () => {
    for (const key of ['a', ' ', 'Backspace', 'Tab', 'ArrowDown', 'Delete']) {
      expect(kanbanQuickAddCommand(key, false), `${key} was not left to the field`).toBeNull()
    }
  })

  it('does not read a modified Enter as a filing of its own', () => {
    // Control/Alt+Enter are not chords the field claims; only Shift changes what Enter means.
    expect(kanbanQuickAddCommand('Enter', false)).toEqual({ kind: 'file', openDetail: false })
  })
})
