import { act, createElement, type RefObject } from 'react'
import { describe, expect, it } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { planSlidePages, type SlideBlock, type SlidePlan } from './slide-pagination'
import { usePresentationNav } from './use-presentation-session'

// N-31's other half: the rule that a press walks steps before pages and pages before slides lives in
// `forwardMove`, but the show only behaves that way if the nav feeds it the *page's* step count and
// resets the step where a page change should reset it. These read the position the way a presenter
// would feel it — which block is on screen after each press.
const BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
  { top: 300, height: 100, heading: false },
  { top: 400, height: 100, heading: false },
]

const hashes = ['hash-one', 'hash-two']

function Host({ navRef }: { navRef: RefObject<ReturnType<typeof usePresentationNav> | null> }) {
  navRef.current = usePresentationNav(['# One', '# Two'], hashes, 0)
  return null
}

const position = (nav: ReturnType<typeof usePresentationNav>) => ({ slide: nav.index, page: nav.sub, step: nav.step })

function press(action: (nav: ReturnType<typeof usePresentationNav>) => void, navRef: RefObject<ReturnType<typeof usePresentationNav> | null>) {
  act(() => {
    action(navRef.current!)
  })
}

describe('the turn walks steps, then pages, then slides', () => {
  it('reveals a page block by block before turning it', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    const stepped = planSlidePages(BLOCKS, 320, undefined, true)
    press((nav) => nav.handlePlan(stepped), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 0, page: 0, step: 0 })

    press((nav) => nav.goNext(), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 0, page: 0, step: 1 })
    press((nav) => nav.goNext(), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 0, page: 0, step: 2 })
    press((nav) => nav.goNext(), navRef)
    expect(position(navRef.current!), 'the last step of the page turns it').toEqual({ slide: 0, page: 1, step: 0 })
    view.unmount()
  })

  it('turns the page once the last step is on screen, and starts the next page on its first step', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    press((nav) => nav.handlePlan(planSlidePages(BLOCKS, 320, undefined, true)), navRef)
    expect(navRef.current!.plans[0]?.pages.length).toBe(2)
    for (let turn = 0; turn < 3; turn++) press((nav) => nav.goNext(), navRef)
    expect(navRef.current!.sub, 'the page the steps ran out on turns').toBe(1)
    expect(navRef.current!.step).toBe(0)
    view.unmount()
  })

  it('backspaces the page it came from to where that page ended, not to its hidden blocks', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    press((nav) => nav.handlePlan(planSlidePages(BLOCKS, 320, undefined, true)), navRef)
    for (let step = 0; step < 3; step++) press((nav) => nav.goNext(), navRef)
    expect(navRef.current!.sub).toBe(1)
    press((nav) => nav.goPrev(), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 0, page: 0, step: 2 })
    press((nav) => nav.goPrev(), navRef)
    expect(navRef.current!.step).toBe(1)
    view.unmount()
  })

})

describe('the turn when the show is told where to go', () => {
  it('lands on a page the list named as the whole page, and on a new slide as its first page', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    const plan = planSlidePages(BLOCKS, 320, undefined, true)
    press((nav) => nav.handlePlan(plan), navRef)
    press((nav) => nav.jumpToPage(0, 1), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 0, page: 1, step: plan.pages[1]!.to - plan.pages[1]!.from - 1 })
    press((nav) => nav.jumpTo(1), navRef)
    expect(position(navRef.current!)).toEqual({ slide: 1, page: 0, step: 0 })
    view.unmount()
  })

  it('clamps a step the show is on when the slide is re-measured shorter', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    press((nav) => nav.handlePlan(planSlidePages(BLOCKS, 320, undefined, true)), navRef)
    press((nav) => nav.goNext(), navRef)
    press((nav) => nav.goNext(), navRef)
    expect(navRef.current!.step).toBe(2)
    press((nav) => nav.handlePlan(plainPlan()), navRef)
    expect(navRef.current!.step, 'a plan without steps leaves nothing to hold back').toBe(0)
    view.unmount()
  })
})

function plainPlan(): SlidePlan {
  return planSlidePages(BLOCKS, 320)
}

describe('the page reports how far it can be revealed', () => {
  it('reads the step total off the page on screen, and off the next page once that one is on screen', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    press((nav) => nav.handlePlan(planSlidePages(BLOCKS, 320, undefined, true)), navRef)
    // The first page holds three of the five blocks — two presses to reveal them — and its second page
    // carries on one more block, so it has a single press left in it.
    expect(navRef.current!.steps).toBe(2)
    for (let turn = 0; turn < 3; turn++) press((nav) => nav.goNext(), navRef)
    expect(navRef.current!.sub).toBe(1)
    expect(navRef.current!.steps).toBe(1)
    view.unmount()
  })

  it('reports nothing to reveal on a slide without the switch', () => {
    const navRef = { current: null } as RefObject<ReturnType<typeof usePresentationNav> | null>
    const view = renderElement(createElement(Host, { navRef }))
    press((nav) => nav.handlePlan(plainPlan()), navRef)
    expect(navRef.current!.steps).toBe(0)
    view.unmount()
  })
})
