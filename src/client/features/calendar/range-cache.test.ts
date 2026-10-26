import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarEventDto } from '@shared/calendar/model'
import {
  MAX_CACHE_BYTES,
  MAX_CACHED_RANGES,
  clearRanges,
  rangeFor,
  readRanges,
  MAX_PAINT_AGE_MS,
  paintableRange,
  sameRevision,
  saveRange,
  type CachedCalendarRange,
} from './range-cache'

const ALICE = 'user-alice'
const BOB = 'user-bob'

function event(id: string, description = ''): CalendarEventDto {
  return { id, title: id, description } as unknown as CalendarEventDto
}

function entry(from: number, to: number, savedAt: number, events: CalendarEventDto[] = [event('e1')]): CachedCalendarRange {
  return {
    from,
    to,
    savedAt,
    revision: { count: events.length, revSum: events.length, maxUpdatedAt: savedAt },
    events,
    occurrences: events,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('the calendar range cache', () => {
  it('hands back the answer for exactly the range that was stored', () => {
    saveRange(ALICE, entry(100, 200, 5000))
    expect(rangeFor(ALICE, 100, 200)?.events.map(item => item.id)).toEqual(['e1'])
    expect(rangeFor(ALICE, 100, 201)).toBeNull()
    expect(rangeFor(BOB, 100, 200)).toBeNull()
  })

  it('keeps accounts apart even on one browser', () => {
    saveRange(ALICE, entry(100, 200, 5000))
    saveRange(BOB, entry(100, 200, 6000, [event('b1')]))
    expect(rangeFor(ALICE, 100, 200)?.events.map(item => item.id)).toEqual(['e1'])
    expect(rangeFor(BOB, 100, 200)?.events.map(item => item.id)).toEqual(['b1'])
    clearRanges(ALICE)
    expect(readRanges(ALICE)).toEqual([])
    expect(readRanges(BOB)).toHaveLength(1)
  })

  it('replaces the same range instead of stacking copies', () => {
    saveRange(ALICE, entry(100, 200, 5000))
    saveRange(ALICE, entry(100, 200, 7000, [event('e2')]))
    const ranges = readRanges(ALICE)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]?.events[0]?.id).toBe('e2')
  })

  it('keeps the newest few and forgets the rest', () => {
    for (let index = 0; index < MAX_CACHED_RANGES + 2; index += 1) {
      saveRange(ALICE, entry(index * 100, index * 100 + 50, 1000 + index))
    }
    const ranges = readRanges(ALICE)
    expect(ranges).toHaveLength(MAX_CACHED_RANGES)
    expect(ranges.map(item => item.from)).toEqual([500, 400, 300, 200])
    expect(rangeFor(ALICE, 0, 50)).toBeNull()
  })

  it('discards a corrupted value and leaves the account able to store again', () => {
    localStorage.setItem('inkstone.calendar.range.v1:user-alice', '{"version":1,"entries":[{"from":')
    expect(readRanges(ALICE)).toEqual([])
    expect(localStorage.getItem('inkstone.calendar.range.v1:user-alice')).toBeNull()
    saveRange(ALICE, entry(100, 200, 5000))
    expect(rangeFor(ALICE, 100, 200)).not.toBeNull()
  })

  it('ignores a file written by a different version', () => {
    localStorage.setItem('inkstone.calendar.range.v1:user-alice', JSON.stringify({ version: 2, entries: [entry(100, 200, 5000)] }))
    expect(readRanges(ALICE)).toEqual([])
  })

  it('refuses a range larger than the whole allowance', () => {
    saveRange(ALICE, entry(100, 200, 5000))
    const huge = entry(300, 400, 6000, [event('big', 'x'.repeat(MAX_CACHE_BYTES + 10))])
    saveRange(ALICE, huge)
    expect(rangeFor(ALICE, 300, 400)).toBeNull()
    expect(rangeFor(ALICE, 100, 200)).not.toBeNull()
  })

  it('survives a storage that refuses every call', () => {
    const hostile: Storage = {
      get length() { return 0 },
      clear: () => { throw new Error('denied') },
      getItem: () => { throw new Error('denied') },
      key: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readRanges(ALICE, hostile)).toEqual([])
    expect(() => saveRange(ALICE, entry(100, 200, 5000), hostile)).not.toThrow()
    expect(() => clearRanges(ALICE, hostile)).not.toThrow()
    expect(rangeFor(ALICE, 100, 200, hostile)).toBeNull()
  })

  it('compares every field of a revision', () => {
    const base = { count: 2, revSum: 5, maxUpdatedAt: 100 }
    expect(sameRevision(base, { ...base })).toBe(true)
    expect(sameRevision(base, { ...base, count: 3 })).toBe(false)
    expect(sameRevision(base, { ...base, revSum: 6 })).toBe(false)
    expect(sameRevision(base, { ...base, maxUpdatedAt: 101 })).toBe(false)
  })

  it('paints the entry that overlaps the range most, not only an identical one', () => {
    saveRange(ALICE, entry(0, 1000, 5000))
    saveRange(ALICE, entry(900, 2000, 6000, [event('near')]))
    // Ranges are recomputed from the clock, so the reader asks for 990..1990 rather than 900..2000.
    expect(paintableRange(ALICE, 990, 1990, localStorage, 5000)?.events[0]?.id).toBe('near')
    expect(paintableRange(ALICE, 5000, 6000, localStorage, 5000)).toBeNull()
  })

  it('will not paint a snapshot older than a week', () => {
    saveRange(ALICE, entry(0, 1000, 5000))
    expect(paintableRange(ALICE, 0, 1000, localStorage, 5000 + MAX_PAINT_AGE_MS - 1)).not.toBeNull()
    expect(paintableRange(ALICE, 0, 1000, localStorage, 5000 + MAX_PAINT_AGE_MS + 1)).toBeNull()
  })
})
