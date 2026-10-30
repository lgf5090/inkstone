// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultState } from '../src/shared/development/api-tester/state'
import { ApiError } from '../src/client/lib/api'
import { putState } from '../src/client/features/development/api-tester/api'
import {
  SAVE_DEBOUNCE_MS,
  SAVE_RETRY_DELAYS_MS,
  StateSaver,
} from '../src/client/features/development/api-tester/persistence'

vi.mock('../src/client/features/development/api-tester/api', () => ({ putState: vi.fn() }))

const put = vi.mocked(putState)

function makeSaver() {
  const events = {
    saving: 0,
    saved: [] as number[],
    conflicts: 0,
    errors: [] as string[],
  }
  const saver = new StateSaver({
    read: () => ({ state: defaultState('ws-1'), workspaceId: 'ws-1' }),
    onSaving: () => { events.saving += 1 },
    onSaved: (rev) => { events.saved.push(rev) },
    onConflict: () => { events.conflicts += 1 },
    onError: (message) => { events.errors.push(message) },
  })
  return { saver, events }
}

describe('API Tester state saver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    put.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('debounces an edit into one save and reports the new revision', async () => {
    put.mockResolvedValue({ rev: 4 })
    const { saver, events } = makeSaver()
    saver.setRev(3)

    saver.markDirty()
    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)

    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('ws-1', 3, expect.any(Object))
    expect(events.saved).toEqual([4])
    expect(events.saving).toBe(1)
  })

  it('stops autosaving on a revision conflict instead of retrying over newer data', async () => {
    put.mockRejectedValue(new ApiError(409, 'apitester_state_conflict', 'saved elsewhere'))
    const { saver, events } = makeSaver()

    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(events.conflicts).toBe(1)

    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_RETRY_DELAYS_MS[0]! * 4)
    expect(put).toHaveBeenCalledTimes(1)
    expect(events.errors).toEqual([])
  })

  it('retries a failed save on its own so a stopped user still gets saved', async () => {
    put
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ rev: 2 })
    const { saver, events } = makeSaver()

    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(events.errors).toEqual(['network down'])
    expect(events.saved).toEqual([])

    await vi.advanceTimersByTimeAsync(SAVE_RETRY_DELAYS_MS[0]!)
    expect(put).toHaveBeenCalledTimes(2)
    expect(events.saved).toEqual([2])
  })

  it('gives up after the retry budget and saves again on the next edit', async () => {
    put.mockRejectedValue(new Error('offline'))
    const { saver, events } = makeSaver()

    saver.markDirty()
    for (const delay of [SAVE_DEBOUNCE_MS, ...SAVE_RETRY_DELAYS_MS]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(put).toHaveBeenCalledTimes(1 + SAVE_RETRY_DELAYS_MS.length)
    expect(events.errors).toHaveLength(1 + SAVE_RETRY_DELAYS_MS.length)

    put.mockResolvedValue({ rev: 9 })
    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(events.saved).toEqual([9])
  })

  it('sends one keepalive write when the state fits the 64 KiB budget', () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { saver } = makeSaver()

    saver.markDirty()
    saver.flushOnHide()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.keepalive).toBe(true)
    expect(init.method).toBe('PUT')
  })

  it('skips the keepalive write when a CJK-heavy state is under 60k characters but over 60k bytes', () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = {
      ...defaultState('ws-1'),
      globalVariables: [{ id: 'g1', key: 'bulk', value: '汉'.repeat(25_000), enabled: true }],
    }
    const saver = new StateSaver({
      read: () => ({ state, workspaceId: 'ws-1' }),
      onSaving: () => {},
      onSaved: () => {},
      onConflict: () => {},
      onError: () => {},
    })

    saver.markDirty()
    saver.flushOnHide()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('retries immediately when the user asks', async () => {
    put
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ rev: 5 })
    const { saver, events } = makeSaver()

    saver.markDirty()
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS)
    expect(events.errors).toHaveLength(1)

    saver.retryNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(put).toHaveBeenCalledTimes(2)
    expect(events.saved).toEqual([5])
  })
})
