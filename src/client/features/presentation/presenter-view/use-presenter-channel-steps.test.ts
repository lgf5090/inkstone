import { createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderElement } from '../../../lib/test-render'
import { buildPresenterSlideState, usePresenterSlideState, type PresenterSlideState, type PresenterStateSource } from './use-presenter-channel'
import { planSlidePages, type SlideBlock } from '../slide-pagination'

// N-31: the console previews what the next press brings, and on a page that arrives in stages the next
// press is a block, not a page. `steps` is read off the plan the payload already carries rather than
// sent across the channel: a step total that disagreed with the plan it came from would print a page
// number the projector never showed.
const STEPPED_BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
  { top: 300, height: 100, heading: false },
  { top: 400, height: 100, heading: false },
]
const STEPPED_PLANS = { 0: planSlidePages(STEPPED_BLOCKS, 320, undefined, true) }
const STEPPED_DECK = ['# One\n\nfirst\n\nsecond\n\nthird\n\nfourth', '# Two']

function steppedState(step: number, subPage = 0): PresenterSlideState {
  return buildPresenterSlideState({
    noteTitle: 'Stepped Deck',
    slideTitles: [],
    slideIndex: 0,
    subPage,
    step,
    slideCount: 2,
    pageCount: 2,
    deck: STEPPED_DECK,
    notes: ['say this', ''],
    plans: STEPPED_PLANS,
    startedAt: 5000,
  })
}

describe('buildPresenterSlideState — a page the room watches arrive in stages', () => {
  it('previews one block more on the page it is on while blocks are left', () => {
    const state = steppedState(0)
    expect(state.step).toBe(0)
    expect(state.steps, 'the plan on screen says how many reveals this page holds').toBe(2)
    expect(state.nextSubPage).toBe(0)
    expect(state.nextStep).toBe(1)
    expect(state.nextSlideSource).toBe(STEPPED_DECK[0])
  })

  it('turns the page only once its last block has arrived, and starts the next one hidden', () => {
    const state = steppedState(2)
    expect(state.nextSubPage).toBe(1)
    expect(state.nextStep).toBe(0)
  })

  it('reads the step total off the page that is on screen, not off the first one', () => {
    const state = steppedState(0, 1)
    expect(state.steps, 'the second page carries on one block, so it has one reveal left in it').toBe(1)
    expect(state.nextStep).toBe(1)
    expect(state.nextSubPage).toBe(1)
  })

  it('has nothing to preview past the last reveal of the last slide', () => {
    const state = buildPresenterSlideState({
      noteTitle: 'One Page',
      slideTitles: [],
      slideIndex: 1,
      subPage: 0,
      step: 0,
      slideCount: 2,
      pageCount: 1,
      deck: STEPPED_DECK,
      notes: ['', ''],
      plans: {},
      startedAt: 5000,
    })
    expect(state.nextSlideSource).toBeNull()
    expect(state.steps).toBe(0)
  })
})

describe('usePresenterSlideState — the payload follows the step', () => {
  // One source object, stable down to the array identities, with only the step varied: the memo this
  // case guards is on the dependency *list*, and a source rebuilt with fresh arrays would recompute
  // for a reason that has nothing to do with the step.
  const PAYLOAD_SOURCE: PresenterStateSource = {
    noteTitle: 'Stepped Deck',
    slideTitles: [],
    slideIndex: 0,
    subPage: 0,
    step: 0,
    slideCount: 2,
    pageCount: 2,
    deck: STEPPED_DECK,
    notes: ['say this', ''],
    plans: STEPPED_PLANS,
    startedAt: 5000,
  }

  function PayloadHost({ step }: { step: number }) {
    payloads.push(usePresenterSlideState({ ...PAYLOAD_SOURCE, step }))
    return null
  }

  let payloads: PresenterSlideState[] = []

  beforeEach(() => {
    payloads = []
  })

  it('rebuilds when only the step has moved, so the console does not freeze mid-page', () => {
    const view = renderElement(createElement(PayloadHost, { step: 0 }))
    view.rerender(createElement(PayloadHost, { step: 1 }))
    view.unmount()
    expect(payloads.map((payload) => payload.step)).toEqual([0, 1])
    expect(payloads.at(-1)!.nextStep).toBe(2)
  })
})
