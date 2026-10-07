import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ProseFont } from '@shared/types'
import type { SlideLayout } from '../slides'
import { planPageSteps, type SlidePlan } from '../slide-pagination'
import { forwardMove } from '../presentation-state'

const PRESENTER_CHANNEL_PREFIX = 'inkstone-presenter-sync'

/** The channel of one presenter session. A `BroadcastChannel` reaches every same-origin document that
 * knows its name, and the payload carries the author's private speaker notes and the note's source, so
 * the name has to be the capability: a document that was never handed the token cannot name this
 * channel, ask for that state, or move the projector. */
export function presenterChannelName(token: string): string {
  return `${PRESENTER_CHANNEL_PREFIX}:${token}`
}

/** The token this window was opened with. The presenter route is `?presenter=<token>`, so the query that
 * selects the route is the token — a hand-typed `?presenter=1` in a fresh tab is not a session. */
export function presenterTokenFromLocation(search: string): string | null {
  return new URLSearchParams(search).get('presenter') || null
}

/** What the console can ask the projector to do. `jump` is the one that carries a number: it is the
 * outline row the presenter clicked, and the show lands on that slide rather than one step over.
 * `editNotes` is the note box handed back to the window that owns the document (PR-M8). */
export type PresenterInboundCommand = 'next' | 'prev' | 'first' | 'last' | { jump: number } | { editNotes: { slide: number, text: string } }

export interface PresenterSlideState {
  noteTitle: string
  slideIndex: number
  subPage: number
  /** How far the page on screen has been revealed, and how many reveals it holds (N-31). The total is
   * read off `currentPlan` rather than sent across: a count that disagreed with the plan in the same
   * payload would print a page number the projector never showed. */
  step: number
  steps: number
  slideCount: number
  pageCount: number
  /** One label per slide, in deck order, for the console's outline. Built where the deck is, so a page
   * turn does not re-read every slide's markup just to print the same list again. */
  slideTitles: string[]
  currentSlideSource: string
  currentLayout?: SlideLayout
  nextSlideSource: string | null
  nextLayout?: SlideLayout
  currentPlan?: SlidePlan
  nextPlan?: SlidePlan
  nextSubPage?: number
  /** Which reveal the next press lands on — zero when the press turns to a page the room has not seen. */
  nextStep: number
  notes: string
  startedAt: number
  proseFont?: ProseFont
}

export type PresenterSyncMessage =
  | { type: 'ready' }
  | { type: 'command'; command: PresenterInboundCommand }
  | { type: 'sync'; state: PresenterSlideState }
  | { type: 'close' }

export function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safeSeconds / 3600)
  const m = Math.floor((safeSeconds % 3600) / 60)
  const s = safeSeconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (h > 0) {
    return `${h}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

export function formatClock(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export function openPresenterWindow(token: string): Window | null {
  if (typeof window === 'undefined') return null
  const url = `${window.location.origin}${window.location.pathname}?presenter=${encodeURIComponent(token)}`
  const win = window.open(url, 'inkstone-presenter', 'width=1100,height=700,menubar=no,toolbar=no,location=no,status=no')
  win?.focus()
  return win
}

/** What the projector is showing: enough to draw the current and next page and the speaker notes. */
export interface PresenterStateSource {
  noteTitle: string
  slideIndex: number
  subPage: number
  /** How far the page on screen has been revealed (N-31) — the console previews the next one. */
  step: number
  slideCount: number
  pageCount: number
  deck: string[]
  notes: string[]
  slideTitles: string[]
  plans: Record<number, SlidePlan>
  startedAt: number
  proseFont?: ProseFont
}

export interface PresenterBroadcasterOptions extends PresenterStateSource {
  open: boolean
  /** The session the presenter window was handed, or null until one has been asked for. */
  token: string | null
  goNext: () => void
  goPrev: () => void
  jumpTo: (index: number) => void
  /** The console's note box, applied to the document this window owns (PR-M8). */
  editSpeakerNote: (slide: number, text: string) => void
}

/** The next press of the turn, which is what the console has to show: one block more while the page is
 * arriving, then the page, then the slide (N-31). Nothing follows the last reveal of the last slide, and
 * that is the only case with nothing to preview. */
function nextPresenterPage(source: { deck: string[]; plans: Record<number, SlidePlan>; slideIndex: number; subPage: number; step: number; steps: number; pageCount: number }): Pick<PresenterSlideState, 'nextSlideSource' | 'nextLayout' | 'nextPlan' | 'nextSubPage' | 'nextStep'> {
  const { deck, plans, slideIndex, subPage, step, steps, pageCount } = source
  const currentPlan = plans[slideIndex]
  const move = forwardMove({ step, steps, sub: subPage, pageCount })
  if (move === 'step') return { nextSlideSource: deck[slideIndex] ?? null, nextLayout: currentPlan?.layout, nextPlan: currentPlan, nextSubPage: subPage, nextStep: step + 1 }
  if (move === 'page') return { nextSlideSource: deck[slideIndex] ?? null, nextLayout: currentPlan?.layout, nextPlan: currentPlan, nextSubPage: subPage + 1, nextStep: 0 }
  if (slideIndex + 1 < deck.length) {
    const next = plans[slideIndex + 1]
    return { nextSlideSource: deck[slideIndex + 1] ?? null, nextLayout: next?.layout, nextPlan: next, nextSubPage: 0, nextStep: 0 }
  }
  return { nextSlideSource: null, nextLayout: undefined, nextPlan: undefined, nextSubPage: 0, nextStep: 0 }
}

export function buildPresenterSlideState(options: PresenterStateSource): PresenterSlideState {
  const { noteTitle, slideIndex, subPage, step, slideCount, pageCount, deck, notes, slideTitles, plans, startedAt, proseFont } = options
  const currentPlan = plans[slideIndex]
  // The step total is read off the plan rather than sent: the payload already carries the plan it came
  // from, and a total that disagreed with it would print a page number the projector never showed.
  const steps = currentPlan ? planPageSteps(currentPlan, subPage) : 0
  return {
    noteTitle,
    slideIndex,
    subPage,
    step,
    steps,
    slideCount,
    pageCount,
    slideTitles,
    currentSlideSource: deck[slideIndex] ?? '',
    currentLayout: currentPlan?.layout,
    ...nextPresenterPage({ deck, plans, slideIndex, subPage, step, steps, pageCount }),
    currentPlan,
    notes: notes[slideIndex] ?? '',
    startedAt,
    proseFont,
  }
}

/** The console payload, rebuilt only when something a presenter surface reads has actually moved. Both
 * consumers go through here — the window's broadcaster and the in-show fallback panel — so the dependency
 * list exists once. The session hands fresh navigation callbacks on every render, and a payload recomputed
 * per render would turn every chrome redraw, and every auto-hide tick, into another broadcast of the same
 * page. A field added to `PresenterStateSource` has to join this list, or the payload starts freezing
 * while the show moves on. */
export function usePresenterSlideState(source: PresenterStateSource): PresenterSlideState {
  const { noteTitle, slideIndex, subPage, step, slideCount, pageCount, deck, notes, slideTitles, plans, startedAt, proseFont } = source
  return useMemo(
    () => buildPresenterSlideState({ noteTitle, slideIndex, subPage, step, slideCount, pageCount, deck, notes, slideTitles, plans, startedAt, proseFont }),
    [noteTitle, slideIndex, subPage, step, slideCount, pageCount, deck, notes, slideTitles, plans, startedAt, proseFont],
  )
}

function useBroadcasterChannel(
  open: boolean,
  token: string | null,
  stateRef: React.RefObject<PresenterSlideState>,
  navRef: React.RefObject<{ goNext: () => void; goPrev: () => void; jumpTo: (i: number) => void; slideCount: number; editSpeakerNote: (slide: number, text: string) => void }>,
  readyRef: React.RefObject<boolean>,
) {
  const channelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    if (!open || !token || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(presenterChannelName(token))
    channelRef.current = channel
    readyRef.current = false

    channel.onmessage = (event: MessageEvent<PresenterSyncMessage>) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'ready') {
        // The window that announces itself is the audience: the state is handed over here rather than on
        // mount, so a token whose window never arrived — a blocked popup, now served by the fallback
        // panel — keeps the show from reciting the author's notes at an empty channel.
        readyRef.current = true
        try {
          channel.postMessage({ type: 'sync', state: stateRef.current })
        } catch {
          // Best-effort channel post
        }
      } else if (msg.type === 'command') {
        handleInboundCommand(msg.command, navRef.current)
      } else if (msg.type === 'close') {
        readyRef.current = false
      }
    }

    return () => {
      try {
        channel.postMessage({ type: 'close' })
      } catch {
        // Channel already closed
      }
      channel.close()
      channelRef.current = null
    }
  }, [open, token, stateRef, navRef, readyRef])

  return channelRef
}

export function usePresenterBroadcaster(options: PresenterBroadcasterOptions): void {
  const { open, token, slideCount, goNext, goPrev, jumpTo, editSpeakerNote } = options
  const navRef = useRef({ goNext, goPrev, jumpTo, slideCount, editSpeakerNote })
  navRef.current = { goNext, goPrev, jumpTo, slideCount, editSpeakerNote }

  const statePayload = usePresenterSlideState(options)
  const stateRef = useRef(statePayload)
  stateRef.current = statePayload
  const readyRef = useRef(false)

  const channelRef = useBroadcasterChannel(open, token, stateRef, navRef, readyRef)

  useEffect(() => {
    // `readyRef` is deliberately not a dependency: a newly arrived window is served by the handshake in
    // the channel, and what this effect owes is only the changes that happen while one is listening.
    if (!open || !readyRef.current || !channelRef.current) return
    try {
      channelRef.current.postMessage({ type: 'sync', state: statePayload })
    } catch {
      // Best-effort channel post
    }
  }, [open, statePayload, channelRef])
}

function handleInboundCommand(command: PresenterInboundCommand, nav: { goNext: () => void; goPrev: () => void; jumpTo: (i: number) => void; slideCount: number; editSpeakerNote: (slide: number, text: string) => void }) {
  if (typeof command !== 'string') {
    // The show's own clamp is what makes a hand-typed message on the channel no better than a click.
    if ('jump' in command) return nav.jumpTo(command.jump)
    return nav.editSpeakerNote(command.editNotes.slide, command.editNotes.text)
  }
  switch (command) {
    case 'next':
      return nav.goNext()
    case 'prev':
      return nav.goPrev()
    case 'first':
      return nav.jumpTo(0)
    case 'last':
      return nav.jumpTo(nav.slideCount - 1)
  }
}

/**
 * The goodbye a presenter window says when it stops listening, wrapped so both senders can call it.
 *
 * React's cleanup runs on unmount, and the browser fires `pagehide` when it throws a document away —
 * which is the case no cleanup sees, and without the word the projector keeps an audience it no longer
 * has and recites one message per turn into nothing (L-7). Sending it twice is fine by design: a channel
 * that is already closed refuses both the post and the close, and refusing is what this state means.
 */
function channelGoodbye(channel: BroadcastChannel, channelRef: RefObject<BroadcastChannel | null>): () => void {
  return () => {
    try {
      channel.postMessage({ type: 'close' })
    } catch {
      // Channel already closed
    }
    try {
      channel.close()
    } catch {
      // Already closed
    }
    channelRef.current = null
  }
}

export function usePresenterReceiver(token: string | null): {
  state: PresenterSlideState | null
  connected: boolean
  sendCommand: (command: PresenterInboundCommand) => void
} {
  const [state, setState] = useState<PresenterSlideState | null>(null)
  const [connected, setConnected] = useState(false)
  const channelRef = useRef<BroadcastChannel | null>(null)

  const sendCommand = useCallback((command: PresenterInboundCommand) => {
    try {
      channelRef.current?.postMessage({ type: 'command', command })
    } catch {
      // Best-effort broadcast
    }
  }, [])

  useEffect(() => {
    if (!token || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(presenterChannelName(token))
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent<PresenterSyncMessage>) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'sync') {
        setState(msg.state)
        setConnected(true)
      } else if (msg.type === 'close') {
        setConnected(false)
      }
    }

    try {
      channel.postMessage({ type: 'ready' })
    } catch {
      // Channel initialization
    }

    const goodbye = channelGoodbye(channel, channelRef)
    window.addEventListener('pagehide', goodbye)

    return () => {
      window.removeEventListener('pagehide', goodbye)
      goodbye()
    }
  }, [token])

  return { state, connected, sendCommand }
}
