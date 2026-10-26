// @vitest-environment jsdom
/**
 * A badge that may be behind says so.
 *
 * The sidebar's counts are the server's aggregate, refreshed after every write. When that refresh fails
 * the last good numbers stay on screen — blanking them would be worse — but a number the reader cannot
 * trust has to look different from one they can. `countsStale` is that difference: set when the refresh
 * fails, cleared by any read that answers, and read by the nav beside the numbers themselves rather than
 * only in a toast that has already faded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import type { TaskCounts } from '@shared/todos/model'
import { useTodos } from './store'

const service = vi.hoisted(() => ({ fail: false, counts: null as TaskCounts | null }))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => { throw new Error('not used here') },
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      counts: async () => {
        if (service.fail) throw new Error('the aggregate refused to answer')
        return { counts: service.counts!, dayEnd: 0, timezone: 'UTC' }
      },
    },
  },
}))

const COUNTS = {
  inbox: 1, today: 2, upcoming: 0, overdue: 0, all: 3, completed: 0, starred: 0, byList: {}, byTag: {},
} as unknown as TaskCounts

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.fail = false
  service.counts = COUNTS
  useTodos.setState({ counts: null, countsStale: false, status: 'ready' })
})

describe('the badge refresh', () => {
  it('starts without any doubt about the numbers', () => {
    expect(useTodos.getState().countsStale).toBe(false)
  })

  it('says so when the refresh fails, and keeps the numbers it still has', async () => {
    await useTodos.getState().refreshCounts()
    expect(useTodos.getState().counts).toEqual(COUNTS)
    service.fail = true
    await useTodos.getState().refreshCounts()
    expect(useTodos.getState().countsStale).toBe(true)
    expect(useTodos.getState().counts, 'a failed refresh must not blank the nav').toEqual(COUNTS)
  })

  it('stops saying so as soon as a refresh lands', async () => {
    service.fail = true
    await useTodos.getState().refreshCounts()
    expect(useTodos.getState().countsStale).toBe(true)
    service.fail = false
    await useTodos.getState().refreshCounts()
    expect(useTodos.getState().countsStale).toBe(false)
  })

  it('is quiet while offline, because nothing failed — the reader simply has not synced', async () => {
    service.fail = true
    vi.stubGlobal('navigator', { onLine: false })
    await useTodos.getState().refreshCounts()
    expect(useTodos.getState().countsStale, 'an offline refresh is refused before it is asked').toBe(false)
    vi.unstubAllGlobals()
  })
})
