import { act, createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { renderElement } from '../../../lib/test-render'
import {
  buildPresenterSlideState,
  formatClock,
  formatElapsed,
  openPresenterWindow,
  presenterChannelName,
  presenterTokenFromLocation,
  usePresenterBroadcaster,
  usePresenterReceiver,
  type PresenterBroadcasterOptions,
  type PresenterInboundCommand,
  type PresenterSlideState,
} from './use-presenter-channel'
import { MockBroadcastChannel, flushed, openChannelCount, openChannelNames, resetChannelRegistry, syncPostCount } from './presenter-channel.test-helpers'

describe('use-presenter-channel — formatElapsed and formatClock', () => {
  it('formats elapsed time correctly for seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(45)).toBe('00:45')
    expect(formatElapsed(60)).toBe('01:00')
    expect(formatElapsed(125)).toBe('02:05')
    expect(formatElapsed(3600)).toBe('1:00:00')
    expect(formatElapsed(3665)).toBe('1:01:05')
    expect(formatElapsed(-10)).toBe('00:00')
  })

  it('formats clock time to HH:mm:ss', () => {
    const fixedDate = new Date(2026, 8, 30, 9, 5, 7)
    expect(formatClock(fixedDate)).toBe('09:05:07')
  })
})

describe('openPresenterWindow', () => {
  it('opens a popup whose route carries the session token and focuses it', () => {
    const focusSpy = vi.fn()
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({ focus: focusSpy } as unknown as Window)

    const win = openPresenterWindow('tok-1')
    expect(openSpy).toHaveBeenCalledWith(
      `${window.location.origin}${window.location.pathname}?presenter=tok-1`,
      'inkstone-presenter',
      'width=1100,height=700,menubar=no,toolbar=no,location=no,status=no',
    )
    expect(focusSpy).toHaveBeenCalled()
    expect(win).toBeTruthy()

    openSpy.mockRestore()
  })
})

describe('presenterTokenFromLocation', () => {
  it('reads back the token the route was opened with', () => {
    expect(presenterTokenFromLocation('?presenter=tok-1')).toBe('tok-1')
  })

  it('yields no token for a route that carries none', () => {
    expect(presenterTokenFromLocation('')).toBeNull()
    expect(presenterTokenFromLocation('?presenter=')).toBeNull()
    expect(presenterTokenFromLocation('?note=abc')).toBeNull()
  })
})

function setupPresenterHarness(broadcasterProps: PresenterBroadcasterOptions) {
  let receivedState: PresenterSlideState | null = null
  let isConnected = false
  let triggerCommand: ((cmd: PresenterInboundCommand) => void) | null = null

  function BroadcasterHarness(props: PresenterBroadcasterOptions) {
    usePresenterBroadcaster(props)
    return null
  }

  function ReceiverHarness() {
    const { state, connected, sendCommand } = usePresenterReceiver(broadcasterProps.token)
    useEffect(() => {
      receivedState = state
      isConnected = connected
      triggerCommand = sendCommand
    }, [state, connected, sendCommand])
    return null
  }

  const broadcaster = renderElement(createElement(BroadcasterHarness, broadcasterProps))
  const receiver = renderElement(createElement(ReceiverHarness))

  return {
    broadcaster,
    receiver,
    getState: () => receivedState,
    getConnected: () => isConnected,
    sendCommand: (cmd: PresenterInboundCommand) => triggerCommand!(cmd),
  }
}

function TestBroadcaster({ slide, token = 'tok-1' }: { slide: number, token?: string | null }) {
  usePresenterBroadcaster({
    open: true,
    token,
    noteTitle: 'Channel Test',
    slideIndex: slide,
    subPage: 0,
    step: 0,
    slideCount: 3,
    pageCount: 1,
    deck: ['# A', '# B', '# C'],
    notes: ['', '', ''],
    plans: {},
    startedAt: 1000,
    goNext: vi.fn(),
    goPrev: vi.fn(),
    jumpTo: vi.fn(),
  })
  return null
}

beforeEach(() => {
  resetChannelRegistry()
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('usePresenterBroadcaster — sync and unmount', () => {
  it('broadcasts slide state and unmount close signal', async () => {
    const h = setupPresenterHarness({
      open: true,
      token: 'tok-1',
      noteTitle: 'Keynote Demo',
      slideIndex: 1,
      subPage: 0,
      step: 0,
      slideCount: 3,
      pageCount: 1,
      deck: ['# Slide 1', '# Slide 2', '# Slide 3'],
      notes: ['note 1', 'note 2', 'note 3'],
      plans: {},
      startedAt: 1000000,
      goNext: vi.fn(),
      goPrev: vi.fn(),
      jumpTo: vi.fn(),
    })

    await vi.waitFor(() => {
      expect(h.getConnected()).toBe(true)
      expect(h.getState()).toEqual(expect.objectContaining({ noteTitle: 'Keynote Demo', slideIndex: 1 }))
    })

    act(() => h.broadcaster.unmount())
    await vi.waitFor(() => expect(h.getConnected()).toBe(false))
    act(() => h.receiver.unmount())
  })
})

describe('usePresenterReceiver — inbound commands', () => {
  it('relays remote inbound navigation commands to host session', async () => {
    const goNext = vi.fn()
    const goPrev = vi.fn()
    const jumpTo = vi.fn()

    const h = setupPresenterHarness({
      open: true,
      token: 'tok-1',
      noteTitle: 'Demo',
      slideIndex: 1,
      subPage: 0,
      step: 0,
      slideCount: 3,
      pageCount: 1,
      deck: ['# 1', '# 2', '# 3'],
      notes: ['', '', ''],
      plans: {},
      startedAt: 1000,
      goNext,
      goPrev,
      jumpTo,
    })

    await vi.waitFor(() => expect(h.getConnected()).toBe(true))

    act(() => h.sendCommand('next'))
    await vi.waitFor(() => expect(goNext).toHaveBeenCalledTimes(1))

    act(() => h.sendCommand('prev'))
    await vi.waitFor(() => expect(goPrev).toHaveBeenCalledTimes(1))

    act(() => h.sendCommand('first'))
    await vi.waitFor(() => expect(jumpTo).toHaveBeenCalledWith(0))

    act(() => h.sendCommand('last'))
    await vi.waitFor(() => expect(jumpTo).toHaveBeenCalledWith(2))

    act(() => {
      h.broadcaster.unmount()
      h.receiver.unmount()
    })
  })
})

describe('usePresenterReceiver — channel stability', () => {

  it('keeps BroadcastChannel open and avoids close flicker on state updates', async () => {
    let isConnected = false
    let receivedSlide = -1

    function ReceiverHarness() {
      const { state, connected } = usePresenterReceiver('tok-1')
      useEffect(() => {
        if (state) receivedSlide = state.slideIndex
        isConnected = connected
      }, [state, connected])
      return null
    }

    const broadcaster = renderElement(createElement(TestBroadcaster, { slide: 0 }))
    const receiver = renderElement(createElement(ReceiverHarness))

    await vi.waitFor(() => expect(isConnected).toBe(true))
    expect(receivedSlide).toBe(0)
    const initialChannelsCount = openChannelCount()

    act(() => {
      broadcaster.rerender(createElement(TestBroadcaster, { slide: 1 }))
    })

    await vi.waitFor(() => expect(receivedSlide).toBe(1))
    expect(isConnected).toBe(true)
    expect(openChannelCount()).toBe(initialChannelsCount)

    act(() => {
      broadcaster.unmount()
      receiver.unmount()
    })
  })
})

const channelOptions: PresenterBroadcasterOptions = {
  open: true,
  token: 'tok-1',
  noteTitle: 'Demo',
  slideIndex: 1,
  subPage: 0,
  step: 0,
  slideCount: 3,
  pageCount: 1,
  deck: ['# 1', '# 2', '# 3'],
  // Speaker notes are the private half of what the channel carries, so the isolation cases keep a
  // distinguishable one in slot 0 rather than three empty strings.
  notes: ['private note', '', ''],
  plans: {},
  startedAt: 1000,
  goNext: vi.fn(),
  goPrev: vi.fn(),
  jumpTo: vi.fn(),
}

function ShowHarness({ goNext }: { goNext: () => void }) {
  usePresenterBroadcaster({ ...channelOptions, goNext })
  return null
}

let tokenlessConnected = false
let sendFromTokenlessWindow: ((cmd: PresenterInboundCommand) => void) | null = null

function TokenlessPresenter() {
  const channel = usePresenterReceiver(null)
  tokenlessConnected = channel.connected
  sendFromTokenlessWindow = channel.sendCommand
  return null
}

/** Post at `name` as a same-origin document that never received the token: it may not move the projector,
 * and nothing may come back at it — a `sync` would carry the author's private speaker notes. */
async function probeChannelFromOutside(name: string, goNext: Mock) {
  const rogue = new MockBroadcastChannel(name)
  const received: unknown[] = []
  rogue.onmessage = (event) => received.push(event.data)
  rogue.postMessage({ type: 'ready' })
  rogue.postMessage({ type: 'command', command: 'next' })
  await flushed()
  expect(goNext, name).not.toHaveBeenCalled()
  expect(received, name).toEqual([])
}

describe('presenter session token', () => {
  it('opens no channel before a presenter window has been asked for', async () => {
    const broadcaster = renderElement(createElement(TestBroadcaster, { slide: 0, token: null }))
    await flushed()
    expect(openChannelCount()).toBe(0)
    act(() => broadcaster.unmount())
  })

  it('ignores a document that guesses the untokenised channel name', async () => {
    const goNext = vi.fn()
    const h = setupPresenterHarness({ ...channelOptions, goNext })
    await vi.waitFor(() => expect(h.getConnected()).toBe(true))
    await probeChannelFromOutside('inkstone-presenter-sync', goNext)
    act(() => {
      h.broadcaster.unmount()
      h.receiver.unmount()
    })
  })

  it('ignores a document that guesses the channel of another show', async () => {
    const goNext = vi.fn()
    const h = setupPresenterHarness({ ...channelOptions, goNext })
    await vi.waitFor(() => expect(h.getConnected()).toBe(true))
    await probeChannelFromOutside(presenterChannelName('tok-someone-else'), goNext)
    act(() => {
      h.broadcaster.unmount()
      h.receiver.unmount()
    })
  })

  it('leaves a window that carries no token out of a running show', async () => {
    const goNext = vi.fn()
    tokenlessConnected = false
    const broadcaster = renderElement(createElement(ShowHarness, { goNext }))
    const tokenless = renderElement(createElement(TokenlessPresenter))
    await flushed()

    expect(tokenlessConnected).toBe(false)
    expect(openChannelNames()).toEqual([presenterChannelName('tok-1')])

    act(() => sendFromTokenlessWindow!('next'))
    await flushed()
    expect(goNext).not.toHaveBeenCalled()

    act(() => {
      broadcaster.unmount()
      tokenless.unmount()
    })
  })
})

const subpageTestPlans = {
  0: {
    pages: [{ from: 0, to: 2, top: 0 }, { from: 2, to: 4, top: 300 }],
    scales: [1, 1, 1, 1],
  },
}

describe('buildPresenterSlideState — subpage calculation', () => {

  it('previews next subpage when current slide has remaining subpages', () => {
    const state = buildPresenterSlideState({
      noteTitle: 'Multi-page Deck',
      slideIndex: 0,
      subPage: 0,
      step: 0,
      slideCount: 2,
      pageCount: 2,
      deck: ['# Page 1\n\nPart 1\n\nPart 2', '# Page 2'],
      notes: ['note 1', 'note 2'],
      plans: subpageTestPlans,
      startedAt: 5000,
    })

    expect(state.nextSlideSource).toBe('# Page 1\n\nPart 1\n\nPart 2')
    expect(state.nextSubPage).toBe(1)
    expect(state.nextPlan).toBe(subpageTestPlans[0])
  })

  it('previews next slide when on the last subpage of current slide', () => {
    const state = buildPresenterSlideState({
      noteTitle: 'Multi-page Deck',
      slideIndex: 0,
      subPage: 1,
      step: 0,
      slideCount: 2,
      pageCount: 2,
      deck: ['# Page 1\n\nPart 1\n\nPart 2', '# Page 2'],
      notes: ['note 1', 'note 2'],
      plans: subpageTestPlans,
      startedAt: 5000,
    })

    expect(state.nextSlideSource).toBe('# Page 2')
    expect(state.nextSubPage).toBe(0)
  })
})

describe('buildPresenterSlideState — end of deck', () => {
  it('sets nextSlideSource to null on the final slide and subpage', () => {
    const state = buildPresenterSlideState({
      noteTitle: 'End Deck',
      slideIndex: 1,
      subPage: 0,
      step: 0,
      slideCount: 2,
      pageCount: 1,
      deck: ['# First', '# Final'],
      notes: ['', ''],
      plans: {},
      startedAt: 5000,
    })

    expect(state.nextSlideSource).toBeNull()
  })
})

// A presenter window that the browser throws away never runs React's cleanup, so the goodbye that tells
// the show "nobody is listening" is the one thing that does not go out — and the talk then keeps
// reciting one message per turn into a document that no longer exists (L-7). `pagehide` is the hook the
// browser does promise, so that is where the goodbye lives now.
function ReceiverProbe({ token = 'tok-1' }: { token?: string }) {
  usePresenterReceiver(token)
  return null
}

describe('usePresenterReceiver — the goodbye a discarded document still says', () => {
  it('stops the broadcast once the window is hidden away, without unmounting anything', async () => {
    const broadcaster = renderElement(createElement(TestBroadcaster, { slide: 0 }))
    const receiver = renderElement(createElement(ReceiverProbe))
    await flushed()
    await flushed()

    act(() => {
      broadcaster.rerender(createElement(TestBroadcaster, { slide: 1 }))
    })
    await flushed()
    expect(syncPostCount(), 'a window that is listening gets the turn').toBeGreaterThan(0)

    const channelsBefore = openChannelCount()
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    await flushed()
    expect(openChannelCount(), 'and it lets go of the channel rather than leaving a hidden tab holding one').toBe(channelsBefore - 1)
    const afterGoodbye = syncPostCount()

    act(() => {
      broadcaster.rerender(createElement(TestBroadcaster, { slide: 2 }))
    })
    await flushed()
    expect(syncPostCount(), 'the show is not reciting to a document the browser threw away').toBe(afterGoodbye)

    receiver.unmount()
    broadcaster.unmount()
  })
})
