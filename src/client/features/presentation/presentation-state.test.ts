import { describe, expect, it, vi } from 'vitest'
import { backwardMove, clampSlideIndex, deckProgress, entryIndexOf, escapeAction, exitAsk, forwardMove, interceptSlideLink, isBlockedSlideLinkHref, isSafeSlideLinkHref, nextSliceGap, nextSlicePace, nextUnmeasuredSlide, overviewMove, presentedNoteContent, railEntries, railOpenFor, stageClickDirection, swipeDirection } from './presentation-state'
import type { SlidePlan } from './slide-pagination'

const planOf = (pages: number): SlidePlan => ({
  pages: Array.from({ length: pages }, (_, index) => ({ from: index, to: index + 1, top: index * 100 })),
  scales: Array.from({ length: pages }, () => 1),
})

describe('presentedNoteContent — following', () => {
  it('presents the live note while following', () => {
    expect(presentedNoteContent({ following: true, snapshot: '# Opening', live: '# Opening\n\nRevised', noteExists: true })).toBe('# Opening\n\nRevised')
  })

  it('keeps the snapshot until the note body has loaded', () => {
    expect(presentedNoteContent({ following: true, snapshot: '# Opening', live: undefined, noteExists: true })).toBe('# Opening')
  })

  it('falls back to the snapshot when the note is gone instead of blanking the projector', () => {
    expect(presentedNoteContent({ following: true, snapshot: '# Opening', live: '', noteExists: false })).toBe('# Opening')
  })

  it('still presents an empty note that exists, so clearing the script clears the slides', () => {
    expect(presentedNoteContent({ following: true, snapshot: '# Opening', live: '', noteExists: true })).toBe('')
  })

  it('ignores live edits once frozen', () => {
    expect(presentedNoteContent({ following: false, snapshot: '# Frozen', live: '# Revised', noteExists: true })).toBe('# Frozen')
  })
})

describe('railEntries', () => {
  it('lists one page per slide when every slide fits its canvas', () => {
    expect(railEntries(3, { 0: planOf(1), 1: planOf(1), 2: planOf(1) })).toEqual([
      { slide: 0, sub: 0, pageCount: 1 },
      { slide: 1, sub: 0, pageCount: 1 },
      { slide: 2, sub: 0, pageCount: 1 },
    ])
  })

  it('lists every page of a slide that paginates, so a one-slide note is not a one-entry list', () => {
    const entries = railEntries(1, { 0: planOf(14) })
    expect(entries).toHaveLength(14)
    expect(entries[0]).toEqual({ slide: 0, sub: 0, pageCount: 14 })
    expect(entries[13]).toEqual({ slide: 0, sub: 13, pageCount: 14 })
  })

  it('keeps an unmeasured slide as its own floor of one entry', () => {
    const entries = railEntries(2, { 0: planOf(3) })
    expect(entries).toEqual([
      { slide: 0, sub: 0, pageCount: 3 },
      { slide: 0, sub: 1, pageCount: 3 },
      { slide: 0, sub: 2, pageCount: 3 },
      { slide: 1, sub: 0, pageCount: 1 },
    ])
  })

  it('numbers pages in the order the arrow keys walk them', () => {
    const entries = railEntries(2, { 0: planOf(2), 1: planOf(2) })
    expect(entries.map((entry) => `${entry.slide}.${entry.sub}`)).toEqual(['0.0', '0.1', '1.0', '1.1'])
  })
})

// N-21: the bar under the show has to count the pages the deck measures, not the slides the author
// wrote — otherwise a slide that paginates into fourteen reads as one step of a short deck, and a
// one-slide note is drawn finished before it has been turned.
describe('deckProgress — where the show sits in the page list', () => {
  it('counts a paginating slide as the pages it has', () => {
    expect(deckProgress({ deckLength: 1, plans: { 0: planOf(14) }, index: 0, sub: 0 })).toEqual({ page: 1, pageTotal: 14 })
    expect(deckProgress({ deckLength: 1, plans: { 0: planOf(14) }, index: 0, sub: 13 })).toEqual({ page: 14, pageTotal: 14 })
  })

  it('walks past the pages of the slides already shown', () => {
    const plans = { 0: planOf(3), 1: planOf(2) }
    expect(deckProgress({ deckLength: 2, plans, index: 1, sub: 0 })).toEqual({ page: 4, pageTotal: 5 })
    expect(deckProgress({ deckLength: 2, plans, index: 1, sub: 1 })).toEqual({ page: 5, pageTotal: 5 })
  })

  it('floors an unmeasured deck at one page rather than dividing by zero', () => {
    expect(deckProgress({ deckLength: 0, plans: {}, index: 0, sub: 0 })).toEqual({ page: 1, pageTotal: 1 })
  })

  it('lands on the slide it is on when the page a show asked for is gone', () => {
    // A re-measure can shrink a slide to fewer pages than the position the presenter is holding; the
    // bar still has to say a page the list has, not a fifth of four.
    expect(deckProgress({ deckLength: 2, plans: { 0: planOf(1), 1: planOf(1) }, index: 1, sub: 4 })).toEqual({ page: 2, pageTotal: 2 })
  })
})

describe('entryIndexOf', () => {
  it('finds the page the show is on', () => {
    const entries = railEntries(2, { 0: planOf(2), 1: planOf(3) })
    expect(entryIndexOf(entries, 1, 2)).toBe(4)
  })

  it('falls back to the slide when a re-measure removed that page', () => {
    const entries = railEntries(2, { 0: planOf(2), 1: planOf(1) })
    expect(entryIndexOf(entries, 1, 5)).toBe(2)
  })

  it('reports no match for a slide the list has not reached', () => {
    expect(entryIndexOf(railEntries(1, { 0: planOf(1) }), 3, 0)).toBe(-1)
  })
})

describe('nextUnmeasuredSlide', () => {
  it('walks the deck in order so the list fills top-down', () => {
    expect(nextUnmeasuredSlide(4, [0, 1], 0)).toBe(2)
    expect(nextUnmeasuredSlide(4, [], 0)).toBe(0)
  })

  it('skips the slides that already have a plan and the ones a stalled measure gave up on', () => {
    expect(nextUnmeasuredSlide(5, [0, 2, 3], 0)).toBe(1)
    expect(nextUnmeasuredSlide(3, [0, 1, 2], 0)).toBeNull()
  })

  it('reports the pass as finished once every slide is measured', () => {
    expect(nextUnmeasuredSlide(0, [], 0)).toBeNull()
    expect(nextUnmeasuredSlide(2, [0, 1], 1)).toBeNull()
  })
})

describe('nextSliceGap', () => {
  it('waits longer than the last slice cost, so the pass keeps a fixed share of the thread', () => {
    expect(nextSliceGap(80, 4, 120)).toBe(240)
    expect(nextSliceGap(300, 4, 120)).toBe(900)
  })

  it('keeps a floor so cheap slices cannot cluster into a busy stretch', () => {
    expect(nextSliceGap(5, 4, 120)).toBe(120)
    expect(nextSliceGap(0, 4, 120)).toBe(120)
  })

  it('treats a pass that gave up as the floor rather than an infinite wait', () => {
    expect(nextSliceGap(-1, 4, 120)).toBe(120)
  })
})

describe('nextSlicePace', () => {
  it('stretches the gap after one that dropped frames', () => {
    expect(nextSlicePace(1, 0, 4)).toBe(2)
    expect(nextSlicePace(2, 0, 4)).toBe(4)
  })

  it('holds the stretched pace until the display has been quiet for two gaps', () => {
    expect(nextSlicePace(2, 1, 4)).toBe(2)
    expect(nextSlicePace(2, 2, 4)).toBe(1)
  })

  it('never goes below the gap the slice cost implies', () => {
    expect(nextSlicePace(1, 2, 4)).toBe(1)
    expect(nextSlicePace(1, 5, 4)).toBe(1)
  })

  it('bounds how far a busy stretch can slow the list down', () => {
    expect(nextSlicePace(4, 0, 4)).toBe(4)
    expect(nextSlicePace(4, 3, 4)).toBe(2)
  })
})

describe('railOpenFor', () => {
  it('follows the viewport until the presenter chooses', () => {
    expect(railOpenFor(null, true)).toBe(true)
    expect(railOpenFor(null, false)).toBe(false)
  })

  it('lets an explicit choice outlive a viewport change', () => {
    expect(railOpenFor(true, false)).toBe(true)
    expect(railOpenFor(false, true)).toBe(false)
  })
})

describe('escapeAction', () => {
  it('exits fullscreen when presentation is fullscreen to prevent accidental dismissal', () => {
    expect(escapeAction({ fullscreen: true, laser: false, overview: false })).toBe('exitFullscreen')
  })

  it('closes presentation overlay when presentation is in windowed mode', () => {
    expect(escapeAction({ fullscreen: false, laser: false, overview: false })).toBe('close')
  })

  it('puts the laser out before it costs the talk a screen or the show', () => {
    expect(escapeAction({ fullscreen: true, laser: true, overview: false })).toBe('clearLaser')
    expect(escapeAction({ fullscreen: false, laser: true, overview: false })).toBe('clearLaser')
  })

  it('puts the spotlight out before it costs the talk a screen or the show', () => {
    expect(escapeAction({ fullscreen: true, laser: false, overview: false, spotlight: true })).toBe('clearSpotlight')
    expect(escapeAction({ fullscreen: false, laser: false, overview: false, spotlight: true })).toBe('clearSpotlight')
  })

  // Three booleans read as nothing in a call, and the order of the ladder is the whole rule: the
  // names are what keep a future rung from being inserted under the wrong one.
  it('puts the overview away first, since it is the screen the presenter is looking at', () => {
    expect(escapeAction({ fullscreen: true, laser: true, overview: true, spotlight: true })).toBe('closeOverview')
    expect(escapeAction({ fullscreen: false, laser: false, overview: true })).toBe('closeOverview')
  })

  // N-17: the key card is painted over the grid it sits on, so it is the layer Escape puts away first —
  // the same rule that keeps the grid from costing a talk its show.
  it('puts the key card away before the screen it is painted over', () => {
    expect(escapeAction({ fullscreen: true, laser: true, overview: true, spotlight: true, keyGuide: true })).toBe('closeKeyGuide')
    expect(escapeAction({ fullscreen: false, laser: false, overview: false, keyGuide: true })).toBe('closeKeyGuide')
  })

  it('puts the marker away before it costs the talk a screen or the show', () => {
    expect(escapeAction({ fullscreen: true, laser: false, overview: false, ink: true })).toBe('clearInk')
    expect(escapeAction({ fullscreen: true, laser: true, overview: true, spotlight: true, ink: true })).toBe('closeOverview')
    expect(escapeAction({ fullscreen: false, laser: false, overview: false, spotlight: true, ink: true })).toBe('clearSpotlight')
  })

  // PR-L3: the question a show with an audience asks is the topmost layer on the screen, and Escape is
  // its answer of "stay". It has to outrank every rung above, or a second press ends the talk the first
  // one was meant to protect.
  it('answers an open exit question as staying, whatever else is on the screen', () => {
    expect(escapeAction({ fullscreen: true, laser: true, overview: true, spotlight: true, keyGuide: true, exitConfirm: true })).toBe('cancelExitConfirm')
    expect(escapeAction({ fullscreen: false, laser: false, overview: false, exitConfirm: true })).toBe('cancelExitConfirm')
    expect(escapeAction({ fullscreen: true, laser: false, overview: false, exitConfirm: false })).toBe('exitFullscreen')
  })
})

describe('overviewMove', () => {
  it('walks the row with the horizontal keys', () => {
    expect(overviewMove('ArrowRight', 4, 12, 4)).toBe(5)
    expect(overviewMove('ArrowLeft', 4, 12, 4)).toBe(3)
  })

  it('walks the column by the row length the grid was painted with', () => {
    expect(overviewMove('ArrowDown', 1, 12, 4)).toBe(5)
    expect(overviewMove('ArrowUp', 5, 12, 4)).toBe(1)
  })

  it('holds the edges instead of leaving the grid', () => {
    expect(overviewMove('ArrowLeft', 0, 12, 4)).toBe(0)
    expect(overviewMove('ArrowRight', 11, 12, 4)).toBe(11)
    expect(overviewMove('ArrowUp', 1, 12, 4)).toBe(0)
    expect(overviewMove('ArrowDown', 11, 12, 4)).toBe(11)
  })

  it('jumps to the deck ends with Home and End', () => {
    expect(overviewMove('Home', 7, 12, 4)).toBe(0)
    expect(overviewMove('End', 7, 12, 4)).toBe(11)
  })

  it('leaves a key the grid does not own to the show', () => {
    expect(overviewMove('PageDown', 7, 12, 4)).toBeNull()
    expect(overviewMove('Enter', 7, 12, 4)).toBeNull()
  })

  it('has nowhere to move in a grid with no cards', () => {
    expect(overviewMove('ArrowRight', 0, 0, 4)).toBeNull()
  })
})

describe('stageClickDirection', () => {
  it('goes previous on the left 35% of the stage', () => {
    expect(stageClickDirection(0, 1000)).toBe('prev')
    expect(stageClickDirection(349, 1000)).toBe('prev')
  })

  it('goes next on the right 65% of the stage', () => {
    expect(stageClickDirection(350, 1000)).toBe('next')
    expect(stageClickDirection(999, 1000)).toBe('next')
  })
})

describe('swipeDirection', () => {
  it('goes next when swiping left past threshold', () => {
    expect(swipeDirection(-60, 50)).toBe('next')
  })

  it('goes prev when swiping right past threshold', () => {
    expect(swipeDirection(60, 50)).toBe('prev')
  })

  it('ignores minor movement below threshold', () => {
    expect(swipeDirection(-20, 50)).toBeNull()
    expect(swipeDirection(20, 50)).toBeNull()
  })
})

describe('interceptSlideLink', () => {
  it('opens safe external https and http links in new window', () => {
    const openMock = vi.fn()
    const result = interceptSlideLink('https://example.com/talk', openMock)
    expect(result).toBe(true)
    expect(openMock).toHaveBeenCalledWith('https://example.com/talk', '_blank', 'noopener,noreferrer')
  })

  it('opens mailto links in new window', () => {
    const openMock = vi.fn()
    const result = interceptSlideLink('mailto:speaker@example.com', openMock)
    expect(result).toBe(true)
    expect(openMock).toHaveBeenCalledWith('mailto:speaker@example.com', '_blank', 'noopener,noreferrer')
  })

  it('rejects hash jumps and does not open window', () => {
    const openMock = vi.fn()
    expect(interceptSlideLink('#slide-heading', openMock)).toBe(false)
    expect(interceptSlideLink('#', openMock)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('rejects unsafe protocols like javascript:', () => {
    const openMock = vi.fn()
    expect(interceptSlideLink('javascript:alert(1)', openMock)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()
  })

  it('rejects empty and null links', () => {
    const openMock = vi.fn()
    expect(interceptSlideLink('', openMock)).toBe(false)
    expect(interceptSlideLink(null, openMock)).toBe(false)
    expect(interceptSlideLink(undefined, openMock)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()
  })
})

describe('isSafeSlideLinkHref', () => {
  const cases: Array<[href: string, expected: boolean]> = [
    ['https://example.com/talk', true],
    ['http://example.com/talk', true],
    ['mailto:speaker@example.com', true],
    ['tel:+1000000000', true],
    ['HTTPS://example.com/talk', true],
    ['Http://example.com/talk', true],
    ['MAILTO:speaker@example.com', true],
    ['  https://example.com/talk  ', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['data:text/html,hi', false],
    ['/notes/another', false],
    ['#slide-heading', false],
    ['', false],
  ]

  it.each(cases)('judges %j as %j', (href, expected) => {
    expect(isSafeSlideLinkHref(href)).toBe(expected)
  })

  it('folds only the scheme, so the path the author wrote keeps its case', () => {
    const openMock = vi.fn()
    expect(interceptSlideLink('HTTPS://Example.COM/Talk#Section', openMock)).toBe(true)
    expect(openMock).toHaveBeenCalledWith('HTTPS://Example.COM/Talk#Section', '_blank', 'noopener,noreferrer')
  })
})

describe('isBlockedSlideLinkHref', () => {
  it('leaves an in-page anchor or a missing href unannounced', () => {
    expect(isBlockedSlideLinkHref('#slide-heading')).toBe(false)
    expect(isBlockedSlideLinkHref('')).toBe(false)
    expect(isBlockedSlideLinkHref(null)).toBe(false)
    expect(isBlockedSlideLinkHref(undefined)).toBe(false)
  })

  it('reports every href a real link got refused for', () => {
    expect(isBlockedSlideLinkHref('javascript:alert(1)')).toBe(true)
    expect(isBlockedSlideLinkHref('ftp://example.com')).toBe(true)
    expect(isBlockedSlideLinkHref('/notes/another')).toBe(true)
    expect(isBlockedSlideLinkHref('HTTPS://example.com')).toBe(false)
  })
})

// N-31: the order the projector walks a stepped slide — step, then page, then slide — is the whole
// feature's contract with a presenter's thumb, so it is named and tested apart from the state machine
// that reads it.
describe('forwardMove and backwardMove', () => {
  it('walks the steps of the page before turning it', () => {
    expect(forwardMove({ step: 0, steps: 2, sub: 0, pageCount: 3 })).toBe('step')
    expect(forwardMove({ step: 1, steps: 2, sub: 0, pageCount: 3 })).toBe('step')
  })

  it('turns the page once its last step is on screen, and the slide once its pages are spent', () => {
    expect(forwardMove({ step: 2, steps: 2, sub: 0, pageCount: 3 })).toBe('page')
    expect(forwardMove({ step: 2, steps: 2, sub: 2, pageCount: 3 })).toBe('slide')
    expect(forwardMove({ step: 0, steps: 0, sub: 0, pageCount: 1 })).toBe('slide')
  })

  it('lifts the last step back off the page before leaving the page', () => {
    expect(backwardMove({ step: 2, sub: 0 })).toBe('step')
    expect(backwardMove({ step: 0, sub: 1 })).toBe('page')
    expect(backwardMove({ step: 0, sub: 0 })).toBe('slide')
  })
})

// L-12: the slide level of the show's three clamps. The sub-page and the slice each had a direct case
// of their own; this one was only ever reached *through* a key press, so a regression here was a red
// somewhere else rather than a named failure.
describe('clampSlideIndex keeps the show on a slide the deck has', () => {
  it('lands a resumed position back on the last slide when the deck lost the one it remembered', () => {
    expect(clampSlideIndex(8, 3)).toBe(2)
    expect(clampSlideIndex(2, 3), 'a position the deck still has is left alone').toBe(2)
  })

  it('holds at both ends of a jump', () => {
    expect(clampSlideIndex(-4, 5)).toBe(0)
    expect(clampSlideIndex(99, 5)).toBe(4)
  })

  it('has no slide to be on when the deck is empty — and never an index off either end of it', () => {
    expect(clampSlideIndex(0, 0)).toBe(0)
    expect(clampSlideIndex(6, 0), 'an empty deck answers 0, not -1: every reader indexes with this').toBe(0)
  })
})

describe('exitAsk', () => {
  it('asks before ending a talk somebody else is watching', () => {
    expect(exitAsk({ audienceFollowing: true })).toBe('ask')
  })

  it('just closes when nobody is following', () => {
    expect(exitAsk({ audienceFollowing: false })).toBe('close')
  })
})
