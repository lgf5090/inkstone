import { describe, expect, it } from 'vitest'
import {
  dayKeyOf,
  dateShapeOf,
  isPropertyEmpty,
  parsePropertyValueDate,
  propertyDisplayText,
  propertyValueKind,
  propertyValuesOf,
  relativeDateOf,
} from './property-values'

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()

describe('propertyValueKind', () => {
  it('reads the widgets the front matter can carry', () => {
    expect(propertyValueKind('text', 'title')).toBe('text')
    expect(propertyValueKind(3, 'rating')).toBe('number')
    expect(propertyValueKind(true, 'done')).toBe('boolean')
    expect(propertyValueKind(['a'], 'tags')).toBe('tags')
    expect(propertyValueKind(['a'], 'TAGS')).toBe('tags')
    expect(propertyValueKind(['a'], 'people')).toBe('array')
    expect(propertyValueKind(null, 'x')).toBe('text')
    expect(propertyValueKind({ a: 1 }, 'x')).toBe('object')
  })
})

describe('propertyValuesOf', () => {
  it('splits a list into its items and keeps a scalar as one item', () => {
    expect(propertyValuesOf(['a', 'b'])).toEqual(['a', 'b'])
    expect(propertyValuesOf('solo')).toEqual(['solo'])
    expect(propertyValuesOf('')).toEqual([])
    expect(propertyValuesOf(7)).toEqual(['7'])
    expect(propertyValuesOf(null)).toEqual([])
  })

  it('renders the object shape the note template can write', () => {
    expect(propertyDisplayText({ a: 1 })).toBe('{"a":1}')
    expect(propertyDisplayText(['x', 'y'])).toBe('x, y')
    expect(propertyDisplayText(new Date(NOW))).toBe('2026-10-08')
  })
})

describe('isPropertyEmpty', () => {
  it('treats blank text and an empty list as empty', () => {
    expect(isPropertyEmpty('   ')).toBe(true)
    expect(isPropertyEmpty([])).toBe(true)
    expect(isPropertyEmpty(null)).toBe(true)
    expect(isPropertyEmpty(0)).toBe(false)
    expect(isPropertyEmpty(false)).toBe(false)
    expect(isPropertyEmpty('x')).toBe(false)
  })
})

describe('dateShapeOf and parsePropertyValueDate', () => {
  it('names a plain day and a day with a time', () => {
    expect(dateShapeOf('2026-10-08')).toBe('date')
    expect(dateShapeOf('2026-10-08T07:30')).toBe('datetime')
    expect(dateShapeOf('2026-10-08 07:30:15')).toBe('datetime')
    expect(dateShapeOf('2026-10-08T07:30:15.250Z')).toBe('datetime')
    expect(dateShapeOf('2026-13-08')).toBe(null)
    expect(dateShapeOf('yesterday')).toBe(null)
    expect(dateShapeOf(20261008)).toBe(null)
  })

  it('rejects a day that does not exist', () => {
    expect(parsePropertyValueDate('2026-02-30')).toBe(null)
    expect(parsePropertyValueDate('2026-04-31')).toBe(null)
    expect(parsePropertyValueDate('2026-10-08T25:00')).toBe(null)
  })

  it('keeps an explicit offset and reads a bare time as local', () => {
    const utc = parsePropertyValueDate('2026-10-08T00:00Z')
    const offset = parsePropertyValueDate('2026-10-08T08:00+08:00')
    expect(utc?.time).toBe(offset?.time)
    const bare = parsePropertyValueDate('2026-10-08T00:00')
    expect(bare?.dayKey).toBe('2026-10-08')
  })
})

describe('relativeDateOf', () => {
  it('buckets a day by the calendar, not by the clock', () => {
    expect(relativeDateOf('2026-10-08', NOW)).toBe('present')
    expect(relativeDateOf('2026-10-07', NOW)).toBe('past')
    expect(relativeDateOf('2026-10-09', NOW)).toBe('future')
    expect(relativeDateOf('not a date', NOW)).toBe('none')
  })

  it('buckets a timestamp by the minute it names', () => {
    expect(relativeDateOf('2026-10-08T11:51', NOW)).toBe('past')
    expect(relativeDateOf('2026-10-08T11:59', NOW)).toBe('past')
    expect(relativeDateOf('2026-10-08T12:00', NOW)).toBe('present')
    expect(relativeDateOf('2026-10-08T12:00:30', NOW)).toBe('present')
    expect(relativeDateOf('2026-10-08T12:01', NOW)).toBe('future')
  })

  it('rounds a day key into the reader\'s own calendar', () => {
    expect(dayKeyOf(NOW)).toBe('2026-10-08')
  })
})
