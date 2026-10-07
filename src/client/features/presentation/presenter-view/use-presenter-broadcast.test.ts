import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { usePresenterBroadcaster, usePresenterReceiver, type PresenterBroadcasterOptions, type PresenterSlideState } from './use-presenter-channel'
import { MockBroadcastChannel, flushed, openChannelCount, resetChannelRegistry, syncPostCount } from './presenter-channel.test-helpers'

// What the show puts on the channel is the author's private notes and the deck's source, so the
// traffic itself is a leak surface: it is counted here rather than only checked for arrival.
// Hoisted because the session's deck and notes are memoized (`useShowDeck` keys them on the note's
// content): a fresh literal per render would make this file measure its own fixture instead of the
// broadcaster, since an unstable payload reads as "the state moved" even when nothing did. The notes
// still change with the page — `buildPresenterSlideState` picks `notes[slideIndex]` from a stable array.
const DECK = ['# A', '# B', '# C']
const NOTES = ['note for A', 'note for B', 'note for C']
const PLANS: PresenterBroadcasterOptions['plans'] = {}

// The outline is compared by identity, like every other array the payload carries: a host that hands a
// fresh `[]` per render has a show that re-broadcasts on every chrome redraw. The session memoises it off
// the deck, and this harness keeps one array for the same reason.
const NO_TITLES: string[] = []

function options(slide: number): PresenterBroadcasterOptions {
  return {
    open: true,
    token: 'tok-1',
    noteTitle: 'Broadcast Economy',
    slideTitles: NO_TITLES,
    slideIndex: slide,
    subPage: 0,
    step: 0,
    slideCount: 3,
    pageCount: 1,
    deck: DECK,
    notes: NOTES,
    plans: PLANS,
    startedAt: 1000,
    goNext: vi.fn(),
    goPrev: vi.fn(),
    jumpTo: vi.fn(),
  }
}

function Broadcaster({ slide }: { slide: number }) {
  usePresenterBroadcaster(options(slide))
  return null
}

function PresenterWindow() {
  lastSeen = usePresenterReceiver('tok-1').state
  return null
}

// What the window is holding right now, read during render rather than from an effect: an effect here
// would update after the assertion that needs it and would report itself as an unwrapped `act` write.
let lastSeen: PresenterSlideState | null = null
let show: RenderedElement | null = null
let presenter: RenderedElement | null = null

function turnTo(slide: number) {
  const root = show
  if (!root) throw new Error('the show never started')
  act(() => root.rerender(createElement(Broadcaster, { slide })))
}

function startShow() {
  show = renderElement(createElement(Broadcaster, { slide: 0 }))
}

function openPresenter() {
  presenter = renderElement(createElement(PresenterWindow))
}

// The mock hands each message over on a microtask, and the receiving hook answers that delivery with
// a `setState`; waiting inside `act` is what lets the update arrive while React is still listening.
async function settle() {
  await act(async () => {
    await flushed()
  })
}

beforeEach(() => {
  resetChannelRegistry()
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
})

afterEach(() => {
  act(() => show?.unmount())
  act(() => presenter?.unmount())
  show = null
  presenter = null
  lastSeen = null
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('who the show is willing to speak to', () => {
  it('says nothing while no document has claimed the channel it was handed a token for', async () => {
    // A handed-out token with no listener is the reachable case, not a hypothetical: a blocked popup
    // still sets the token, and the show then continues in this window with the fallback panel.
    startShow()
    await settle()
    expect(openChannelCount()).toBe(1)
    expect(syncPostCount()).toBe(0)

    turnTo(1)
    await settle()
    expect(syncPostCount()).toBe(0)
  })

  it('goes quiet again when the presenter window closes, so the show stops speaking to nobody', async () => {
    startShow()
    openPresenter()
    await settle()
    expect(syncPostCount()).toBe(1)

    act(() => presenter?.unmount())
    presenter = null
    // The departure is announced over the same asynchronous channel as everything else, so the show
    // only knows the window is gone once that has landed. The case that matters is the next page turn,
    // which happens a beat later in a real talk.
    await settle()

    turnTo(2)
    await settle()
    expect(syncPostCount()).toBe(1)
  })
})

describe('what one page turn costs', () => {
  it('carries the state to the window the moment it asks, and after that only when the state moves', async () => {
    startShow()
    openPresenter()
    await settle()
    expect(syncPostCount()).toBe(1)

    // Two renders of the same page: the deck, notes and plans are referentially stable, so a chrome
    // redraw must not be a broadcast. Fresh callbacks are included because the session passes new
    // ones every render, and they are not part of what the presenter reads.
    turnTo(0)
    turnTo(0)
    await settle()
    expect(syncPostCount()).toBe(1)

    turnTo(1)
    await settle()
    expect(syncPostCount()).toBe(2)
  })

  // The economy must not cost freshness: waiting for the handshake is only correct if what comes back
  // is where the show is now, not where it was when the projector mounted.
  it('hands a window that arrives late the page it missed, notes and all', async () => {
    startShow()
    turnTo(2)
    await settle()
    openPresenter()
    await settle()
    expect(lastSeen?.slideIndex).toBe(2)
    expect(lastSeen?.notes).toBe('note for C')
  })
})
