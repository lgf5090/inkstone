import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    localStorage.setItem(`inkstone.calendar.first-paint.v3:${ALICE}`, '{"version":2,"meta":{"calendars":')
    expect(readFirstPaintMeta(ALICE)).toBeNull()
    expect(localStorage.getItem(`inkstone.calendar.first-paint.v3:${ALICE}`)).toBeNull()
  })

  it('ignores a file written by a different version', () => {
    localStorage.setItem(`inkstone.calendar.first-paint.v3:${ALICE}`, JSON.stringify({ version: 1, meta: meta() }))
    expect(readFirstPaintMeta(ALICE)).toBeNull()
  })

  it('stores only the first-paint whitelist and removes private mutable collections', () => {
    const full = {
      ...meta(),
      subscriptions: [{ url: 'https://feeds.example.com/private/token' }],
      connections: [{ username: 'private-user', baseUrl: 'https://dav.example.com' }],
      invites: [{ ownerName: 'Private owner' }],
      resources: [{ name: 'Private room' }],
      schedulingLinks: [{ slug: 'capability-secret' }],
      preferences: { organizerEmail: 'organizer@example.com', reminderEmail: 'reminder@example.com', timeZone: 'UTC' },
    } as unknown as CalendarMetaDto
    saveFirstPaintMeta(ALICE, full)
    const raw = localStorage.getItem(`inkstone.calendar.first-paint.v3:${ALICE}`)!
    expect(raw).not.toContain('private/token')
    expect(raw).not.toContain('private-user')
    expect(raw).not.toContain('Private owner')
    expect(raw).not.toContain('Private room')
    expect(raw).not.toContain('capability-secret')
    expect(raw).not.toContain('organizer@example.com')
    expect(raw).not.toContain('reminder@example.com')
    expect(readFirstPaintMeta(ALICE)).toMatchObject({
      subscriptions: [], connections: [], invites: [], resources: [], schedulingLinks: [],
      preferences: { organizerEmail: '', reminderEmail: '' },
    })
  })

  it('drops the old v1 snapshot that carried subscription URLs and usernames', () => {
    localStorage.setItem(`inkstone.calendar.first-paint.v1:${ALICE}`, JSON.stringify({
      version: 1,
      meta: { ...meta(), subscriptions: [{ url: 'https://feeds.example.com/private/token' }] },
    }))
    expect(readFirstPaintMeta(ALICE)).toBeNull()
    expect(localStorage.getItem(`inkstone.calendar.first-paint.v1:${ALICE}`)).toBeNull()
  })

  it('refuses metadata larger than the allowance', () => {
    const huge = meta('x'.repeat(300 * 1024))
    saveFirstPaintMeta(ALICE, huge)
    expect(readFirstPaintMeta(ALICE)).toBeNull()
  })

  it('stops retrying legacy cleanup after the migration window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-04-02T00:00:00Z'))
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      localStorage.setItem(`inkstone.calendar.first-paint.v2:${ALICE}`, '{"version":1}')
      expect(readFirstPaintMeta(ALICE)).toBeNull()
      expect(remove).not.toHaveBeenCalled()
      expect(localStorage.getItem(`inkstone.calendar.first-paint.v2:${ALICE}`)).not.toBeNull()
    } finally {
      remove.mockRestore()
      vi.useRealTimers()
    }
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
