import { describe, expect, it } from 'vitest'
import { nextEventSelection } from './event-selection'

const ordered = ['a', 'b', 'c', 'd']

describe('event multi-selection', () => {
  it('uses a plain click as a single selection and Cmd/Ctrl as a toggle', () => {
    expect(nextEventSelection(new Set(['a', 'b']), ordered, 'c', { shift: false, meta: false }, 'a'))
      .toEqual({ selected: new Set(['c']), anchor: 'c' })
    expect(nextEventSelection(new Set(['a', 'b']), ordered, 'b', { shift: false, meta: true }, 'a'))
      .toEqual({ selected: new Set(['a']), anchor: 'b' })
  })

  it('adds the inclusive Shift range without dropping existing selections', () => {
    expect(nextEventSelection(new Set(['d']), ordered, 'b', { shift: true, meta: false }, 'c'))
      .toEqual({ selected: new Set(['d', 'b', 'c']), anchor: 'c' })
  })

  it('falls back to a single selection when the anchor is no longer visible', () => {
    expect(nextEventSelection(new Set(['d']), ordered, 'b', { shift: true, meta: false }, 'gone'))
      .toEqual({ selected: new Set(['b']), anchor: 'b' })
  })
})
