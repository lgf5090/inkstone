import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_WINDOW,
  hiddenCount,
  sliceWindow,
} from './official-library-window'

describe('the official catalog grid renders a window', () => {
  const items = Array.from({ length: 232 }, (_, i) => `l-${i}`)

  it('starts with one screenful of cards', () => {
    expect(OFFICIAL_WINDOW).toBe(24)
    expect(sliceWindow(items, OFFICIAL_WINDOW)).toHaveLength(24)
    expect(sliceWindow(items, OFFICIAL_WINDOW)[0]).toBe('l-0')
    expect(sliceWindow(items, OFFICIAL_WINDOW)[23]).toBe('l-23')
  })

  it('counts what the tail still owes the reader', () => {
    expect(hiddenCount(items, OFFICIAL_WINDOW)).toBe(208)
    expect(hiddenCount(items, 232)).toBe(0)
    expect(hiddenCount(items, 400)).toBe(0)
  })

  it('hands back the array itself once the window covers it', () => {
    // A fresh array every render would defeat the memoised cards for no reason.
    expect(sliceWindow(items, 400)).toBe(items)
    expect(sliceWindow(items, 232)).toBe(items)
    expect(sliceWindow(items, 231)).not.toBe(items)
  })

  it('survives an empty catalog', () => {
    expect(sliceWindow([], 24)).toEqual([])
    expect(hiddenCount([], 24)).toBe(0)
  })
})
