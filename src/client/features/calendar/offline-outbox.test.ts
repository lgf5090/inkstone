import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import type { CalendarEventInput } from '@shared/calendar/model'
import { enqueueOutbox, flushOutbox, outboxEventIds, readOutbox, removeOutbox } from './offline-outbox'
import * as api from './api'

vi.mock('./api', () => ({
  createEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))

const createEvents = vi.mocked(api.createEvents)
const updateEvent = vi.mocked(api.updateEvent)
const deleteEvent = vi.mocked(api.deleteEvent)

function input(id: string, title: string): CalendarEventInput {
  return {
    id,
    title,
    start: { value: '2026-11-02T09:00:00', type: 'datetime' },
    end: { value: '2026-11-02T10:00:00', type: 'datetime' },
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the offline calendar outbox', () => {
  it('keeps one entry per event, newest intent and base revision win', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'First'), baseRev: 2, at: 1 })
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Second'), baseRev: 7, at: 2 })
    const entries = readOutbox('u1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'save', eventId: 'e1', baseRev: 7 })
    expect((entries[0] as { input: CalendarEventInput }).input.title).toBe('Second')
  })

  it('exposes durable queued event ids for range mirroring', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'new', input: input('new', 'New'), baseRev: null, at: 1 })
    await enqueueOutbox('u1', { kind: 'delete', eventId: 'gone', rev: 4, at: 2 })
    expect([...outboxEventIds('u1')].sort()).toEqual(['gone', 'new'])
    expect(outboxEventIds('other')).toEqual(new Set())
  })

  it('creates new rows, conditionally patches existing rows and deletes with the recorded revision', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'new', input: input('new', 'New'), baseRev: null, at: 1 })
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Later'), baseRev: 4, at: 2 })
    await enqueueOutbox('u1', { kind: 'delete', eventId: 'e2', rev: 4, at: 3 })
    createEvents.mockResolvedValue([])
    updateEvent.mockResolvedValue({ rev: 5 } as never)
    deleteEvent.mockResolvedValue()

    const result = await flushOutbox('u1')

    expect(result).toEqual({ flushed: 3, dropped: 0, conflicts: 0 })
    expect(createEvents).toHaveBeenCalledWith([expect.objectContaining({ id: 'new' })], 'create')
    expect(updateEvent).toHaveBeenCalledWith('e1', expect.objectContaining({ id: 'e1', title: 'Later' }), 4)
    expect(deleteEvent).toHaveBeenCalledWith('e2', 4)
    expect(readOutbox('u1')).toEqual([])
  })

  it('keeps the queue when the network is still gone', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Offline'), baseRev: 1, at: 1 })
    updateEvent.mockRejectedValue(new ApiError(0, 'offline', 'offline'))

    expect(await flushOutbox('u1')).toEqual({ flushed: 0, dropped: 0, conflicts: 0 })
    expect(readOutbox('u1')).toHaveLength(1)
  })

  it('reports discarded permanent refusals and non-API failures for refresh', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Forbidden'), baseRev: 1, at: 1 })
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e2', input: input('e2', 'Broken'), baseRev: 1, at: 2 })
    updateEvent.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'no'))
    updateEvent.mockRejectedValueOnce(new Error('unexpected response'))

    expect(await flushOutbox('u1')).toEqual({ flushed: 0, dropped: 2, conflicts: 0 })
    expect(readOutbox('u1')).toEqual([])
  })

  it('moves a stale conditional patch to conflict handling without upserting it', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Mine'), baseRev: 3, at: 1 })
    updateEvent.mockRejectedValue(new ApiError(409, 'conflict', 'stale revision'))
    const onConflict = vi.fn()

    expect(await flushOutbox('u1', { onConflict })).toEqual({ flushed: 0, dropped: 0, conflicts: 1 })
    expect(onConflict).toHaveBeenCalledWith({
      id: 'e1',
      intent: 'save',
      mine: expect.objectContaining({ title: 'Mine' }),
    })
    expect(createEvents).not.toHaveBeenCalled()
    expect(readOutbox('u1')).toEqual([])
  })

  it('migrates a valid durable row from the legacy key without losing it', () => {
    localStorage.setItem('inkstone:calendar:outbox:u1', JSON.stringify([
      { kind: 'save', eventId: 'e1', input: input('e1', 'Legacy key'), baseRev: 2, at: 1 },
    ]))

    expect(readOutbox('u1')).toEqual([
      expect.objectContaining({ kind: 'save', eventId: 'e1', baseRev: 2 }),
    ])
    expect(localStorage.getItem('inkstone.calendar.outbox.v1:u1')).not.toBeNull()
    expect(localStorage.getItem('inkstone:calendar:outbox:u1')).toBeNull()
  })

  it('reports and discards legacy rows whose base revision is unknown instead of overwriting', async () => {
    localStorage.setItem('inkstone:calendar:outbox:u1', JSON.stringify([
      { kind: 'save', eventId: 'e1', input: input('e1', 'Legacy'), at: 1 },
    ]))

    expect(await flushOutbox('u1')).toEqual({ flushed: 0, dropped: 1, conflicts: 0 })
    expect(createEvents).not.toHaveBeenCalled()
    expect(updateEvent).not.toHaveBeenCalled()
    expect(readOutbox('u1')).toEqual([])
  })

  it('keeps a stale row when no conflict handler is available', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Mine'), baseRev: 3, at: 1 })
    updateEvent.mockRejectedValue(new ApiError(409, 'conflict', 'stale revision'))

    expect(await flushOutbox('u1')).toEqual({ flushed: 0, dropped: 0, conflicts: 0 })
    expect(readOutbox('u1')).toHaveLength(1)
  })

  it('removes a queued create when its offline event is deleted', async () => {
    await enqueueOutbox('u1', { kind: 'save', eventId: 'new', input: input('new', 'New'), baseRev: null, at: 1 })
    await removeOutbox('u1', 'new')
    expect(readOutbox('u1')).toEqual([])
  })

  it('does not persist conference passwords, host controls or opaque metadata', async () => {
    const event = input('e1', 'Meeting')
    event.conference = {
      provider: 'zoom',
      joinUrl: 'https://meet.example.com/join/123',
      meetingId: '123',
      hostUrl: 'https://meet.example.com/host/private',
      password: 'private-passcode',
      meta: { accessToken: 'private-token' },
    }
    await enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: event, baseRev: 1, at: 1 })

    const raw = localStorage.getItem('inkstone.calendar.outbox.v1:u1') ?? ''
    expect(raw).not.toContain('private')
    expect(readOutbox('u1')[0]).toMatchObject({
      input: { conference: { provider: 'zoom', joinUrl: 'https://meet.example.com/join/123', meetingId: '123' } },
    })
    expect(event.conference.password).toBe('private-passcode')
  })

  it('rejects a write instead of claiming an edit was queued', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    await expect(enqueueOutbox('u1', {
      kind: 'save', eventId: 'e1', input: input('e1', 'Mine'), baseRev: 1, at: 1,
    })).rejects.toThrow('could not be saved for offline sync')
  })

  it('rejects the 201st distinct event instead of silently evicting an edit', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      kind: 'save' as const,
      eventId: `e${index}`,
      input: input(`e${index}`, `Event ${index}`),
      baseRev: null,
      at: index,
    }))
    localStorage.setItem('inkstone.calendar.outbox.v1:u1', JSON.stringify(entries))

    await expect(enqueueOutbox('u1', {
      kind: 'save', eventId: 'overflow', input: input('overflow', 'Overflow'), baseRev: null, at: 201,
    })).rejects.toThrow('full (200 events)')
    expect(readOutbox('u1')).toHaveLength(200)
    expect(readOutbox('u1').some(entry => entry.eventId === 'e0')).toBe(true)
  })

  it('serialises concurrent read-modify-write operations through Web Locks', async () => {
    let tail = Promise.resolve()
    let active = 0
    let maxActive = 0
    const request = vi.fn(async (_name: string, task: () => Promise<void>) => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      await previous
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await task()
      } finally {
        active--
        release()
      }
    })
    vi.stubGlobal('navigator', { locks: { request } })

    await Promise.all(Array.from({ length: 10 }, (_, index) => enqueueOutbox('u1', {
      kind: 'save', eventId: `e${index}`, input: input(`e${index}`, `Event ${index}`), baseRev: null, at: index,
    })))

    expect(request).toHaveBeenCalledTimes(10)
    expect(request.mock.calls.every(([name]) => name === 'inkstone.calendar.outbox.v1:u1')).toBe(true)
    expect(maxActive).toBe(1)
    expect(readOutbox('u1')).toHaveLength(10)
  })

  it('keeps concurrent same-tab writes when Web Locks is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await Promise.all(Array.from({ length: 10 }, (_, index) => enqueueOutbox('u1', {
      kind: 'save', eventId: `e${index}`, input: input(`e${index}`, `Event ${index}`), baseRev: null, at: index,
    })))
    expect(readOutbox('u1')).toHaveLength(10)
  })

})
