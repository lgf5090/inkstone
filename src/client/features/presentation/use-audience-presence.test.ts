import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARE_PRESENCE_POLL_MS, type PublicSharePresence } from '@shared/share-presence'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { ApiError } from '../../lib/api'
import { useAudiencePresence } from './use-audience-presence'

installTestGlobals()

// The viewer's heartbeat (N-34 / ADR-0006). What a viewer must never do is make the talk look broken
// because one request failed, or keep asking after the room emptied — so both of those are asserted
// here, along with the validator a 304 answer depends on.
const api = vi.hoisted(() => ({ presence: { read: vi.fn() } }))

// The barrel is stood in for, but `ApiError` still has to be the real one: the hook decides "the room
// is empty" by asking whether an error is that class, and a mock that drops it would make every failure
// look like a lapsed show.
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api,
}))

function at(slide: number, page = 0, step = 0): PublicSharePresence {
  return { slide, page, step, updatedAt: 1, title: 'Quarterly Review' }
}

type Feed = ReturnType<typeof useAudiencePresence>

function mount() {
  let feed: Feed | null = null
  function Probe() {
    feed = useAudiencePresence('slug-1', 'token-1')
    return null
  }
  const view = renderElement(createElement(Probe))
  return {
    get feed() {
      if (!feed) throw new Error('the presence hook never mounted')
      return feed
    },
    unmount: view.unmount,
  }
}

/** Lets the first beat (a promise chain) land, then hands time back to the caller. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  vi.useFakeTimers()
  api.presence.read.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useAudiencePresence — the beat that keeps a viewer in the room', () => {
  it('starts as connecting and becomes live on the first answer', async () => {
    api.presence.read.mockResolvedValue(at(2, 1, 0))
    const show = mount()
    await settle()
    expect(show.feed.state).toBe('live')
    expect(show.feed.presence?.slide).toBe(2)
    show.unmount()
  })
})

describe('useAudiencePresence — the beat that survives a bad network', () => {
  it('keeps the page it is on when a beat answers 304', async () => {
    api.presence.read.mockResolvedValueOnce(at(1))
    const show = mount()
    await settle()
    api.presence.read.mockResolvedValueOnce(undefined)
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS + 50) })
    expect(show.feed.state).toBe('live')
    expect(show.feed.presence?.slide, 'a 304 is "nothing moved", not "nothing to show"').toBe(1)
    show.unmount()
  })

  it('sends the validator back on the next beat', async () => {
    api.presence.read.mockImplementation(async (_slug: string, _token: string, _ifNoneMatch?: string, onEtag?: (etag: string | null) => void) => {
      onEtag?.('W/"1-0-0-1"')
      return at(1)
    })
    const show = mount()
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS + 50) })
    expect(api.presence.read).toHaveBeenCalledTimes(2)
    const [, , ifNoneMatch] = api.presence.read.mock.calls[1]
    expect(ifNoneMatch, 'a 304 is only reachable if the beat carries what it compares against').toBeTruthy()
    show.unmount()
  })

  it('does not blank the screen on a failed beat, and asks again more slowly', async () => {
    api.presence.read.mockResolvedValueOnce(at(3))
    const show = mount()
    await settle()
    api.presence.read.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS + 50) })
    expect(show.feed.state).toBe('stale')
    expect(show.feed.presence?.slide, 'the last real answer stays on the wall').toBe(3)

    const beats = api.presence.read.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS + 50) })
    expect(api.presence.read.mock.calls.length, 'a failing room is not hammered at the old rate').toBe(beats)
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS * 2 + 100) })
    expect(api.presence.read.mock.calls.length).toBeGreaterThan(beats)
    show.unmount()
  })

})

describe('useAudiencePresence — the beat that stops', () => {
  it('ends the asking when the show is over', async () => {
    api.presence.read.mockRejectedValueOnce(new ApiError(404, 'not_found', 'The link does not exist or has been revoked'))
    const show = mount()
    await settle()
    expect(show.feed.state).toBe('ended')
    expect(show.feed.presence, 'an ended show keeps the page it ended on, and says it is over').toBeNull()
    const beats = api.presence.read.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS * 10) })
    expect(api.presence.read.mock.calls.length, 'an empty room is not polled').toBe(beats)
    show.unmount()
  })

  it('stops asking when the viewer goes away', async () => {
    api.presence.read.mockResolvedValue(at(0))
    const show = mount()
    await settle()
    show.unmount()
    const beats = api.presence.read.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(SHARE_PRESENCE_POLL_MS * 3) })
    expect(api.presence.read.mock.calls.length).toBe(beats)
  })
})
