import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarMetaDto } from '@shared/calendar/model'
import { readFirstPaintMeta, saveFirstPaintMeta } from './first-paint'

const ALICE = 'user-alice'
const BOB = 'user-bob'

function meta(name = 'Home'): CalendarMetaDto {
  return {
    calendars: [{ id: 'cal-1', name, color: '#112233' }],
    groups: [],
    subscriptions: [],
    connections: [],
    preferences: { timeZone: 'Asia/Shanghai' },
  } as unknown as CalendarMetaDto
}

beforeEach(() => {
  localStorage.clear()
})

describe('the first-paint metadata cache', () => {
  it('hands the calendars back to the account that stored them', () => {
    saveFirstPaintMeta(ALICE, meta())
    expect(readFirstPaintMeta(ALICE)?.calendars[0]?.name).toBe('Home')
    expect(readFirstPaintMeta(BOB)).toBeNull()
  })

  it('forgets the entry when the calendars are saved as null', () => {
    saveFirstPaintMeta(ALICE, meta())
    saveFirstPaintMeta(ALICE, null)
    expect(readFirstPaintMeta(ALICE)).toBeNull()
  })

  it('discards a corrupted value instead of guessing the reader calendars', () => {
    localStorage.setItem(`inkstone.calendar.first-paint.v1:${ALICE}`, '{"version":1,"meta":{"calendars":')
    expect(readFirstPaintMeta(ALICE)).toBeNull()
    expect(localStorage.getItem(`inkstone.calendar.first-paint.v1:${ALICE}`)).toBeNull()
  })

  it('ignores a file written by a different version', () => {
    localStorage.setItem(`inkstone.calendar.first-paint.v1:${ALICE}`, JSON.stringify({ version: 2, meta: meta() }))
    expect(readFirstPaintMeta(ALICE)).toBeNull()
  })

  it('refuses metadata larger than the allowance', () => {
    const huge = meta('x'.repeat(300 * 1024))
    saveFirstPaintMeta(ALICE, huge)
    expect(readFirstPaintMeta(ALICE)).toBeNull()
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
    expect(readFirstPaintMeta(ALICE, hostile)).toBeNull()
    expect(() => saveFirstPaintMeta(ALICE, meta(), hostile)).not.toThrow()
    expect(() => saveFirstPaintMeta(ALICE, null, hostile)).not.toThrow()
  })
})
