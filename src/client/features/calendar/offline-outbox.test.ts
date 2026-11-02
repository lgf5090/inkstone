import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/api'
import type { CalendarEventInput } from '@shared/calendar/model'
import { clearOutbox, enqueueOutbox, flushOutbox, readOutbox } from './offline-outbox'
import * as api from './api'

vi.mock('./api', () => ({
  createEvents: vi.fn(),
  deleteEvent: vi.fn(),
}))

const createEvents = vi.mocked(api.createEvents)
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

describe('the offline calendar outbox', () => {
  it('keeps one entry per event, newest intent wins', () => {
    enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'First'), at: 1 })
    enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Second'), at: 2 })
    const entries = readOutbox('u1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'save', eventId: 'e1' })
    expect((entries[0] as { input: CalendarEventInput }).input.title).toBe('Second')
  })

  it('replays saves as upserts and deletes with the recorded revision', async () => {
    enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Later'), at: 1 })
    enqueueOutbox('u1', { kind: 'delete', eventId: 'e2', rev: 4, at: 2 })
    createEvents.mockResolvedValue([])
    deleteEvent.mockResolvedValue()
    const result = await flushOutbox('u1')
    expect(result).toEqual({ flushed: 2, pending: 0, stopped: false })
    expect(createEvents).toHaveBeenCalledWith([expect.objectContaining({ id: 'e1' })], 'upsert')
    expect(deleteEvent).toHaveBeenCalledWith('e2', 4)
    expect(readOutbox('u1')).toEqual([])
  })

  it('keeps the queue when the network is still gone and drops a permanent refusal', async () => {
    enqueueOutbox('u1', { kind: 'save', eventId: 'e1', input: input('e1', 'Offline'), at: 1 })
    createEvents.mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    expect((await flushOutbox('u1')).stopped).toBe(true)
    expect(readOutbox('u1')).toHaveLength(1)

    createEvents.mockRejectedValue(new ApiError(403, 'forbidden', 'no'))
    expect((await flushOutbox('u1')).stopped).toBe(false)
    expect(readOutbox('u1')).toHaveLength(0)
    clearOutbox('u1')
  })
})
