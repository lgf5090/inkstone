// The rules that decide what a running show presents, kept pure so the session
// behavior is testable without a browser: which note content is on screen, what a
// freeze pins, whether the slide list opens with the viewport, and how the deck
// flattens into the page list the sidebar shows.

import type { SlidePlan } from './slide-pagination'

export interface PresentedContentOptions {
  following: boolean
  /** Content captured at start, or pinned by an explicit freeze. */
  snapshot: string
  /** Live note content; undefined until the note's body is loaded. */
  live: string | undefined
  /** False once the note is deleted, closed, or otherwise gone from memory. */
  noteExists: boolean
}

// Following reads the live note, but a note that disappeared must never blank the
// projector mid-talk: the last snapshot stays up until the presenter exits.
export function presentedNoteContent(options: PresentedContentOptions): string {
  if (!options.following) return options.snapshot
  if (!options.noteExists) return options.snapshot
  return options.live ?? options.snapshot
}

// The slide list opens by default where the viewport has room for it, and an
// explicit toggle during the show wins over that default.
export function railOpenFor(choice: boolean | null, fitsViewport: boolean): boolean {
  return choice ?? fitsViewport
}

// The ladder `Esc` walks: the question a show asks before it ends comes first, because the key that
// opened it must not be the key that closes it. Then the layer the presenter is looking at — the card,
// painted over the grid it can sit on, then the grid — so neither the key card, the overview grid nor
// the laser ever costs a talk its show, then the screen, then the show. Named fields because three
// booleans in a row say nothing about which rung is which.
export function escapeAction({ fullscreen, laser, overview, spotlight, ink, keyGuide, exitConfirm }: { fullscreen: boolean; laser: boolean; overview: boolean; spotlight?: boolean; ink?: boolean; keyGuide?: boolean; exitConfirm?: boolean }): 'cancelExitConfirm' | 'closeKeyGuide' | 'closeOverview' | 'clearSpotlight' | 'clearInk' | 'clearLaser' | 'exitFullscreen' | 'close' {
  if (exitConfirm) return 'cancelExitConfirm'
  if (keyGuide) return 'closeKeyGuide'
  if (overview) return 'closeOverview'
  if (spotlight) return 'clearSpotlight'
  if (ink) return 'clearInk'
  if (laser) return 'clearLaser'
  return fullscreen ? 'exitFullscreen' : 'close'
}

/**
 * Whether leaving the show is a fact or a question (PR-L3). With an audience following, the same
 * keystroke ends somebody else's talk too, and only the presenter knows whether that is the plan —
 * so the press asks first. Without one, closing a show is closing a window: no ceremony.
 */
export function exitAsk({ audienceFollowing }: { audienceFollowing: boolean }): 'ask' | 'close' {
  return audienceFollowing ? 'ask' : 'close'
}

// Where the arrow puts the focus inside the overview grid. The grid is laid out by the browser, so
// how many cards a row holds is only known once it is painted — which is why the row length comes
// in as a measurement instead of being derived from the index. A key the grid does not roam returns
// null so the show still gets it, and an empty grid has nowhere to go.
export function overviewMove(key: string, from: number, count: number, columns: number): number | null {
  if (count === 0) return null
  const last = count - 1
  const hold = (target: number) => Math.min(Math.max(target, 0), last)
  const width = Math.max(columns, 1)
  switch (key) {
    case 'ArrowRight':
      return hold(from + 1)
    case 'ArrowLeft':
      return hold(from - 1)
    case 'ArrowDown':
      return hold(from + width)
    case 'ArrowUp':
      return hold(from - width)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

export function stageClickDirection(clickX: number, stageWidth: number): 'prev' | 'next' {
  return clickX < stageWidth * 0.35 ? 'prev' : 'next'
}

export function swipeDirection(deltaX: number, threshold = 50): 'prev' | 'next' | null {
  if (deltaX < -threshold) return 'next'
  if (deltaX > threshold) return 'prev'
  return null
}

const SLIDE_LINK_PROTOCOLS = ['https://', 'http://', 'mailto:', 'tel:']

/** A `#` jump stays inside the note, and a link with no href is not a link. */
function isInPageSlideLink(trimmed: string): boolean {
  return trimmed === '' || trimmed.startsWith('#')
}

/** The protocol check both link paths share: left-click on the projector and the right-click menu.
 * Compared case-folded because `HTTPS://` and `Http://` are the same scheme to a browser, so matching
 * the raw text refused links the author means the projector to open. Only the comparison is folded —
 * the href handed to `window.open` keeps its case, where a path's is meaningful. */
export function isSafeSlideLinkHref(href: string | null | undefined): href is string {
  const lower = (href ?? '').trim().toLowerCase()
  return SLIDE_LINK_PROTOCOLS.some((protocol) => lower.startsWith(protocol))
}

/** A link the deck refuses: the author put a real href there, and it is off the whitelist. */
export function isBlockedSlideLinkHref(href: string | null | undefined): boolean {
  const trimmed = (href ?? '').trim()
  return !isInPageSlideLink(trimmed) && !isSafeSlideLinkHref(trimmed)
}

export function interceptSlideLink(
  href: string | null | undefined,
  openWindow: (url: string, target: string, features: string) => void,
): boolean {
  if (!isSafeSlideLinkHref(href)) return false
  openWindow(href.trim(), '_blank', 'noopener,noreferrer')
  return true
}

/** One navigable page: a `---` slide plus the overflow page inside it. */
export interface RailEntry {
  slide: number
  sub: number
  pageCount: number
}

// The sidebar lists pages, not `---` slides: a note that never uses `---` is one
// slide but many pages, and a one-entry list would hide everything the arrow keys
// can reach. A slide whose layout has not been measured yet contributes a single
// entry — that is its floor, and it expands to its real pages once the canvas
// measures it. Order is the order the show walks, so numbering and clicking agree.
export function railEntries(deckLength: number, plans: Record<number, SlidePlan>): RailEntry[] {
  const entries: RailEntry[] = []
  for (let slide = 0; slide < deckLength; slide++) {
    const pages = plans[slide]?.pages.length ?? 1
    for (let sub = 0; sub < Math.max(pages, 1); sub++) entries.push({ slide, sub, pageCount: Math.max(pages, 1) })
  }
  return entries
}

// Which page of the whole show the presenter is on, counted over the pages every slide measures:
// the same list the slide rail walks and the overview grid roams, so the bar under the projector
// cannot tell a different story about the same moment. A position the deck no longer has (a slide
// re-measured shorter mid-talk) falls back to that slide's own first page, and an empty deck floors
// at one page rather than dividing by zero.
export function deckProgress({ deckLength, plans, index, sub }: { deckLength: number; plans: Record<number, SlidePlan>; index: number; sub: number }): { page: number; pageTotal: number } {
  const entries = railEntries(deckLength, plans)
  return { page: Math.max(entryIndexOf(entries, index, sub), 0) + 1, pageTotal: Math.max(entries.length, 1) }
}

// Which slide an idle preflight pass should measure next: deck order so the slide list
// fills top-down, skipping the slides that already have a plan and the ones a stalled
// measure gave up on (the canvas still measures those when the show reaches them).
export function nextUnmeasuredSlide(deckLength: number, measured: Iterable<number>, from: number): number | null {
  const done = new Set(measured)
  for (let slide = Math.max(from, 0); slide < deckLength; slide++) {
    if (!done.has(slide)) return slide
  }
  return null
}

// How long the idle pass waits before its next slice. One slice is a single unpausable
// commit — a markdown render, a diagram and a pagination measure — worth tens of
// milliseconds, so the wait is derived from what the last slice actually cost rather than
// from a fixed delay: the pass then uses at most a fixed share of the main thread on any
// machine, and a slower one takes longer to fill the list instead of stuttering through a
// talk. The floor keeps back-to-back slices from clustering into a busy stretch.
export function nextSliceGap(lastSliceMs: number, duty: number, floorMs: number): number {
  return Math.max(floorMs, Math.round(lastSliceMs * (duty - 1)))
}

// A frame this long between two slices means the page was not keeping up on its own, so the gap
// the slice cost implies is not enough room on this machine right now.
export const LAG_FRAME_MS = 50

// How many gaps in a row have to be quiet before the pace comes back down.
const QUIET_RUN = 2

/** How many quanta of the computed gap the pass waits, and how many quiet gaps it has seen. */
export interface SlicePace {
  factor: number
  quietRun: number
}

// The pass's pace, as a multiple of the gap its slice cost implies: a gap that dropped frames
// doubles it, one quiet gap is not enough to undo that, and two are — so a machine that is busy
// for a while (a diagram rendering, another tab, a heavy note) gets a slower fill instead of
// company, and gets the fast fill back as soon as it can take it. `max` bounds how far a busy
// stretch can push the list towards never finishing.
export function nextSlicePace(current: number, quietRun: number, max: number): number {
  if (quietRun === 0) return Math.min(max, current * 2)
  if (quietRun >= QUIET_RUN) return Math.max(1, current / 2)
  return current
}

// The entry the show is on, so the list can mark and scroll to it. A slide whose
// pages shrank under a re-measure still resolves to its nearest page.
export function entryIndexOf(entries: RailEntry[], slide: number, sub: number): number {
  const exact = entries.findIndex((entry) => entry.slide === slide && entry.sub === sub)
  if (exact >= 0) return exact
  const nearest = entries.findIndex((entry) => entry.slide === slide)
  return nearest
}

// N-31: what one press of the turn does on a slide that reveals itself step by step. The order is the
// feature: steps inside the page first, then the page, then the slide — and back again in the same
// order reversed, so a presenter who overshoots one press comes back to the block they just hid.
export type PageMove = 'step' | 'page' | 'slide'

/** How far the current page is revealed: `step` is what is on screen now, `steps` what it is worth. */
export function forwardMove({ step, steps, sub, pageCount }: { step: number; steps: number; sub: number; pageCount: number }): PageMove {
  if (step < steps) return 'step'
  return sub < pageCount - 1 ? 'page' : 'slide'
}

/** Backward needs no step count: which step the page before this one is entered at is the caller's
 * measurement to make, and this rule only decides that a page is what the press moves to. */
export function backwardMove({ step, sub }: { step: number; sub: number }): PageMove {
  if (step > 0) return 'step'
  return sub > 0 ? 'page' : 'slide'
}

/** Whether the turn has anywhere to go, read the same way the two moves above are: the surfaces that
 * offer a press — the pill, the right-click rows, the presenter console — say so on themselves, and a
 * page that is still arriving has a press left in it whatever slide it sits on (N-31). */
export function hasBackwardMove({ index, sub, step }: { index: number; sub: number; step: number }): boolean {
  return index > 0 || sub > 0 || step > 0
}

export function hasForwardMove({ index, count, sub, pageCount, step, steps }: { index: number; count: number; sub: number; pageCount: number; step: number; steps: number }): boolean {
  return index < count - 1 || sub < pageCount - 1 || step < steps
}

/**
 * A slide index kept inside the deck.
 *
 * Three rules wear one shape: a show resumed against a note that has since lost slides cannot open
 * past the end, a deck that shrinks mid-talk pulls the presenter back onto a slide that still exists,
 * and a jump — from a key, the slide list or the overview — has no end to walk past. An empty deck
 * answers `0` rather than `-1`: there is no slide to be on, but there is no index that is off either
 * end of it, and every reader of this value indexes into the deck with it.
 */
export function clampSlideIndex(index: number, deckLength: number): number {
  return Math.max(0, Math.min(index, Math.max(0, deckLength - 1)))
}
