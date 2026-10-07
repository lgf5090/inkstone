import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement } from '../../../lib/test-render'
import { PresenterWindow, type PresenterWindowProps } from './presenter-window'
import { usePresenterTimer, useSlideTimings } from './use-presenter-timer'
import type { PresenterSlideState } from './use-presenter-channel'
import { planSlidePages, type SlideBlock } from '../slide-pagination'

beforeAll(async () => {
  await initI18n()
})

let cleanups: (() => void)[] = []

afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function renderPresenter(props: PresenterWindowProps = {}) {
  const rendered = renderElement(createElement(PresenterWindow, props))
  cleanups.push(rendered.unmount)
  return rendered
}

const mockSlideState: PresenterSlideState = {
  noteTitle: 'Project Architecture',
  slideTitles: ['Opening', 'Core Pillars', 'Roadmap', 'Closing'],
  slideIndex: 1,
  subPage: 0,
  step: 0,
  steps: 0,
  slideCount: 4,
  pageCount: 1,
  currentSlideSource: '# Core Pillars\n\n- Security\n- Performance',
  nextSlideSource: '# Roadmap\n\nQ4 Deliverables',
  nextStep: 0,
  notes: 'Emphasize zero overhead and deterministic fallbacks.',
  startedAt: Date.now() - 65000,
}

describe('PresenterWindow — layout and rendering', () => {
  it('renders disconnected placeholder when state is empty', () => {
    const { container } = renderPresenter()
    expect(container.textContent).toContain(t('workspace.presentation_disconnected'))
  })

  it('renders title, connection badge, progress counter, and timer when connected', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    expect(container.textContent).toContain('Project Architecture')
    expect(container.textContent).toContain(t('workspace.presentation_connected'))
    expect(container.textContent).toContain('2 / 4')
    expect(container.textContent).toContain(t('workspace.presentation_current_slide'))
    expect(container.textContent).toContain(t('workspace.presentation_next_slide'))
    expect(container.textContent).toContain(t('workspace.presentation_speaker_notes'))
    expect(container.textContent).toContain('Emphasize zero overhead and deterministic fallbacks.')
  })

  it('renders fallback when current slide has no speaker notes', () => {
    const emptyNotesState: PresenterSlideState = { ...mockSlideState, notes: '' }
    const { container } = renderPresenter({ initialState: emptyNotesState })
    expect(container.textContent).toContain(t('workspace.presentation_no_notes'))
  })

  it('renders end-of-deck notice when on the final slide', () => {
    const finalSlideState: PresenterSlideState = { ...mockSlideState, slideIndex: 3, nextSlideSource: null }
    const { container } = renderPresenter({ initialState: finalSlideState })
    expect(container.textContent).toContain(t('workspace.presentation_end_of_deck'))
  })

  it('renders next subpage preview when current slide has subsequent subpage', () => {
    const multiPageState: PresenterSlideState = {
      ...mockSlideState,
      nextSlideSource: '# Core Pillars',
      nextSubPage: 1,
      nextPlan: { pages: [{ from: 0, to: 1, top: 0 }, { from: 1, to: 2, top: 200 }], scales: [1, 1] },
    }
    const { container } = renderPresenter({ initialState: multiPageState })
    expect(container.textContent).toContain(t('workspace.presentation_next_slide'))
  })
})

describe('PresenterWindow — the outline the console reads from (PR-M14)', () => {
  const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-presenter-outline-row]')]
  const label = (row: Element) => [...row.querySelectorAll('span')].map((part) => part.textContent?.trim() ?? '').filter(Boolean).join(' ')

  it('names every slide and marks the one the projector is standing on', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const found = rows(container)
    expect(found.map(label)).toEqual(['1 Opening', '2 Core Pillars', '3 Roadmap', '4 Closing'])
    expect(found[1]?.getAttribute('aria-current')).toBe('true')
    expect(found[0]?.hasAttribute('aria-current'), 'only the page on screen is marked').toBe(false)
  })

  it('keeps a row for a slide with nothing to name, so the numbers still line up', () => {
    const { container } = renderPresenter({ initialState: { ...mockSlideState, slideTitles: ['Opening', '', 'Closing'] } })
    expect(rows(container).map(label)).toEqual(['1 Opening', '2', '3 Closing'])
  })

  it('asks the projector to jump to the row that was pressed', () => {
    const onCommand = vi.fn()
    const { container } = renderPresenter({ initialState: mockSlideState, onCommand })
    act(() => { rows(container)[2]?.click() })
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith({ jump: 2 })
  })

  // The rule the round was about: the notes belong under the slide they are read against, and the other
  // column is what comes next plus the way back. Nothing in the markup says so unless it is asserted.
  it('puts the notes in the same column as the slide they belong to', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const column = container.querySelector('[data-presenter-current-pane]')?.parentElement
    expect(column).toBeTruthy()
    expect(column?.contains(container.querySelector('[data-speaker-notes]') ?? null)).toBe(true)
    expect(column?.contains(container.querySelector('[data-presenter-next-pane]') ?? null), 'the next page is the other column').toBe(false)
    expect(column?.parentElement?.contains(container.querySelector('[data-presenter-outline]') ?? null)).toBe(true)
  })
})

describe('PresenterWindow — button controls', () => {
  it('triggers onCommand on Prev and Next button clicks', () => {
    const onCommand = vi.fn()
    const { container } = renderPresenter({ initialState: mockSlideState, onCommand })

    const prevBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_prev')}"]`)
    const nextBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    expect(prevBtn).toBeTruthy()
    expect(nextBtn).toBeTruthy()

    prevBtn?.click()
    expect(onCommand).toHaveBeenCalledWith('prev')

    nextBtn?.click()
    expect(onCommand).toHaveBeenCalledWith('next')
  })

  it('disables prev button at the start of presentation', () => {
    const startState: PresenterSlideState = { ...mockSlideState, slideIndex: 0, subPage: 0 }
    const { container } = renderPresenter({ initialState: startState })
    const prevBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_prev')}"]`)
    expect(prevBtn?.disabled).toBe(true)
  })

  it('disables next button at the end of presentation', () => {
    const endState: PresenterSlideState = { ...mockSlideState, slideIndex: 3, slideCount: 4, subPage: 0, pageCount: 1 }
    const { container } = renderPresenter({ initialState: endState })
    const nextBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    expect(nextBtn?.disabled).toBe(true)
  })
})

describe('PresenterWindow — keyboard shortcuts', () => {
  it('responds to global navigation shortcuts', () => {
    const onCommand = vi.fn()
    renderPresenter({ initialState: mockSlideState, onCommand })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(onCommand).toHaveBeenCalledWith('next')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(onCommand).toHaveBeenCalledWith('prev')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(onCommand).toHaveBeenCalledWith('next')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    expect(onCommand).toHaveBeenCalledWith('first')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
    expect(onCommand).toHaveBeenCalledWith('last')
  })

  it('closes window on Escape', () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
    renderPresenter({ initialState: mockSlideState })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closeSpy).toHaveBeenCalledTimes(1)
    closeSpy.mockRestore()
  })
})

describe('PresenterWindow — keyboard focus guards', () => {
  it('leaves Space and Enter to focused buttons instead of moving slides', () => {
    const onCommand = vi.fn()
    const { container } = renderPresenter({ initialState: mockSlideState, onCommand })

    const pauseBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_timer_pause')}"]`)
    pauseBtn?.focus()

    pauseBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(onCommand).not.toHaveBeenCalledWith('next')

    pauseBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onCommand).not.toHaveBeenCalledWith('next')
  })

  it('leaves vertical scrolling keys to speaker notes pane when focused', () => {
    const onCommand = vi.fn()
    const { container } = renderPresenter({ initialState: mockSlideState, onCommand })

    const notesPane = container.querySelector('[data-speaker-notes]')
    for (const key of ['PageDown', 'PageUp', 'Home', 'End', ' ', 'ArrowDown', 'ArrowUp']) {
      notesPane?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      expect(onCommand).not.toHaveBeenCalled()
    }

    notesPane?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onCommand).toHaveBeenCalledWith('next')

    notesPane?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(onCommand).toHaveBeenCalledWith('prev')
  })
})

describe('PresenterWindow — timer interactions', () => {
  it('counts the talk from the show clock the projector sent, not from its own clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const { container } = renderPresenter({ initialState: { ...mockSlideState, startedAt: 135_000 } })
    expect(container.textContent, 'the window started its own clock instead of reading the broadcast one').toContain('01:05')
    vi.useRealTimers()
  })

  it('toggles pause and resume on timer button click', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const pauseBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_timer_pause')}"]`)
    expect(pauseBtn).toBeTruthy()

    act(() => pauseBtn?.click())
    const resumeBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_timer_resume')}"]`)
    expect(resumeBtn).toBeTruthy()

    act(() => resumeBtn?.click())
    expect(container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_timer_pause')}"]`)).toBeTruthy()
  })

  it('resets timer when reset button is clicked', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const resetBtn = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_timer_reset')}"]`)
    expect(resetBtn).toBeTruthy()

    act(() => resetBtn?.click())
    expect(container.textContent).toContain('00:00')
  })
})

// PR-L4: the accent is the one colour on this bar that means “look, something is off”. A clock that
// is simply running wore it, so every presenter view opened looking like the talk had overrun.
describe('the elapsed clock’s colour', () => {
  const clockIn = (container: HTMLElement) => container.querySelector('[data-presenter-clock]')

  it('stays out of the alarm colour while the talk is running', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const clock = clockIn(container)
    expect(clock?.className).not.toContain('--accent')
    expect(clock?.className).toContain('--text-primary')
  })

  it('goes to the accent only once the timer is paused', () => {
    const { container } = renderPresenter({ initialState: mockSlideState })
    const pause = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === t('workspace.presentation_timer_pause'))
    act(() => { pause?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(clockIn(container)?.className).toContain('--accent')
  })
})

describe('usePresenterTimer — pause logic', () => {
  it('correctly pauses without jumping ahead upon resumption', () => {
    vi.useFakeTimers()
    const startTime = 100000
    vi.setSystemTime(startTime)

    let timerResult!: ReturnType<typeof usePresenterTimer>
    function TimerHarness({ startedAt }: { startedAt: number }) {
      timerResult = usePresenterTimer(startedAt)
      return null
    }

    const { unmount } = renderElement(createElement(TimerHarness, { startedAt: startTime }))

    act(() => vi.advanceTimersByTime(10000))
    expect(timerResult.elapsedSeconds).toBe(10)

    act(() => timerResult.togglePause())
    expect(timerResult.isPaused).toBe(true)

    act(() => vi.advanceTimersByTime(20000))
    expect(timerResult.elapsedSeconds).toBe(10)

    act(() => timerResult.togglePause())
    expect(timerResult.isPaused).toBe(false)
    expect(timerResult.elapsedSeconds).toBe(10)

    act(() => vi.advanceTimersByTime(5000))
    expect(timerResult.elapsedSeconds).toBe(15)

    unmount()
    vi.useRealTimers()
  })
})

describe('usePresenterTimer — reset logic', () => {
  it('resets elapsed time to zero and continues counting from zero', () => {
    vi.useFakeTimers()
    const startTime = 100000
    vi.setSystemTime(startTime)

    let timerResult!: ReturnType<typeof usePresenterTimer>
    function TimerHarness({ startedAt }: { startedAt: number }) {
      timerResult = usePresenterTimer(startedAt)
      return null
    }

    const { unmount } = renderElement(createElement(TimerHarness, { startedAt: startTime }))

    act(() => vi.advanceTimersByTime(15000))
    expect(timerResult.elapsedSeconds).toBe(15)

    act(() => timerResult.resetTimer())
    expect(timerResult.elapsedSeconds).toBe(0)

    act(() => vi.advanceTimersByTime(4000))
    expect(timerResult.elapsedSeconds).toBe(4)

    unmount()
    vi.useRealTimers()
  })
})

describe('usePresenterTimer — the next show', () => {
  it('starts a new talk from zero instead of adding up the one before it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)

    let timerResult!: ReturnType<typeof usePresenterTimer>
    function TimerHarness({ startedAt }: { startedAt: number }) {
      timerResult = usePresenterTimer(startedAt)
      return null
    }

    const { rerender, unmount } = renderElement(createElement(TimerHarness, { startedAt: 100_000 }))
    act(() => vi.advanceTimersByTime(10_000))
    expect(timerResult.elapsedSeconds).toBe(10)
    // Paused on purpose, so the carry-over this case looks for has something to carry.
    act(() => timerResult.togglePause())
    expect(timerResult.isPaused).toBe(true)

    // The room moves on to another talk, and the channel brings a clock stamped by that show.
    rerender(createElement(TimerHarness, { startedAt: 200_000 }))
    vi.setSystemTime(204_000)
    act(() => vi.advanceTimersByTime(500))
    expect(timerResult.isPaused, 'the new show inherited the previous one’s pause').toBe(false)
    expect(timerResult.elapsedSeconds).toBe(4)

    unmount()
    vi.useRealTimers()
  })
})

// N-31: the console is the speaker's preview of the next press, and on a page that arrives block by
// block the next press is a block. Two panes, one plan, and the digits the projector prints — this is
// the surface where a step that stopped travelling would first be visible.
const STEPPED_SOURCE = '# Stepped\n\nfirst point\n\nsecond point\n\nthird point'
const STEPPED_BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
  { top: 300, height: 100, heading: false },
]
const STEPPED_PLAN = planSlidePages(STEPPED_BLOCKS, 632, undefined, true)

const paneVisibility = (container: HTMLElement, pane: string) => [...container.querySelectorAll(`[data-presenter-${pane}-pane] [data-slide-page] > *`)]
  .map((block) => (block as HTMLElement).style.visibility || 'shown')

describe('PresenterWindow — a page the room watches arrive in stages', () => {
  const STEPPED_STATE: PresenterSlideState = {
    ...mockSlideState,
    slideIndex: 2,
    subPage: 1,
    step: 0,
    steps: 3,
    pageCount: 2,
    slideCount: 14,
    currentSlideSource: STEPPED_SOURCE,
    currentPlan: STEPPED_PLAN,
    nextSlideSource: STEPPED_SOURCE,
    nextPlan: STEPPED_PLAN,
    nextSubPage: 1,
    nextStep: 1,
  }

  it('prints the position the projector prints, reveal included', () => {
    const { container } = renderPresenter({ initialState: { ...STEPPED_STATE, step: 1 } })
    const printed = [...container.querySelectorAll('[data-presenter-position]')].map((item) => item.textContent?.trim() ?? '')
    expect(printed.length, 'the console prints the position twice: the pane header and the stepper').toBeGreaterThan(0)
    expect(printed, 'the console spelled its own position again').toEqual(['3 / 14 · 2/2 · 2/4', '3 / 14 · 2/2 · 2/4'])
  })

  it('holds the page it is on at the reveal the room has reached, and the next one a block further', () => {
    const { container } = renderPresenter({ initialState: STEPPED_STATE })
    expect(paneVisibility(container, 'current'), 'the console shows the state the room is in').toEqual(['shown', 'hidden', 'hidden', 'hidden'])
    expect(paneVisibility(container, 'next'), 'the next pane is one block further than the projector').toEqual(['shown', 'shown', 'hidden', 'hidden'])
  })

  it('keeps the turn alive on the first slide while its page is still arriving', () => {
    const { container } = renderPresenter({ initialState: { ...STEPPED_STATE, slideIndex: 0, subPage: 0, slideCount: 1, pageCount: 1, step: 1 } })
    const prev = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_prev')}"]`)
    const next = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    expect(prev?.disabled, 'a block can still be hidden again').toBe(false)
    expect(next?.disabled, 'a block can still arrive').toBe(false)
  })

  it('puts both turns out of reach on the last reveal of the last slide', () => {
    const { container } = renderPresenter({ initialState: { ...STEPPED_STATE, slideIndex: 0, subPage: 0, slideCount: 1, pageCount: 1, step: 3, steps: 3 } })
    const next = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    expect(next?.disabled).toBe(true)
  })
})

// PR-M9: a rehearsal is about the pages, not only the wall clock. The timings are read off the show's
// own elapsed number, so a paused room is not charged to the page that was up.
describe('useSlideTimings', () => {
  let timings!: ReturnType<typeof useSlideTimings>

  function Host(props: { slide: number; elapsed: number }) {
    timings = useSlideTimings(props.slide, props.elapsed)
    return createElement('span')
  }

  it('counts the current page from the moment it arrived', () => {
    const view = renderElement(createElement(Host, { slide: 0, elapsed: 5 }))
    expect(timings.currentSeconds).toBe(5)
    view.rerender(createElement(Host, { slide: 0, elapsed: 12 }))
    expect(timings.currentSeconds).toBe(12)
    view.unmount()
  })

  it('charges each page for the stretch it held the room', () => {
    const view = renderElement(createElement(Host, { slide: 0, elapsed: 0 }))
    view.rerender(createElement(Host, { slide: 0, elapsed: 10 }))
    view.rerender(createElement(Host, { slide: 1, elapsed: 10 }))
    expect(timings.bySlide[0]).toBe(10)
    expect(timings.currentSeconds).toBe(0)
    view.rerender(createElement(Host, { slide: 1, elapsed: 25 }))
    expect(timings.bySlide).toEqual({ 0: 10, 1: 15 })
    expect(timings.visited).toBe(2)
    view.unmount()
  })

  it('adds to a page the presenter went back to rather than restarting it', () => {
    const view = renderElement(createElement(Host, { slide: 0, elapsed: 0 }))
    view.rerender(createElement(Host, { slide: 1, elapsed: 20 }))
    view.rerender(createElement(Host, { slide: 0, elapsed: 30 }))
    view.rerender(createElement(Host, { slide: 1, elapsed: 40 }))
    view.rerender(createElement(Host, { slide: 1, elapsed: 50 }))
    expect(timings.bySlide[0], 'the first page was held for 20s and again for 10s').toBe(30)
    expect(timings.bySlide[1], 'the second page held 10s, and is still up for 10 more').toBe(20)
    expect(timings.currentSeconds).toBe(10)
    expect(timings.visited).toBe(2)
    view.unmount()
  })
})

describe('the presenter’s per-page clock', () => {
  it('says how long this page has held the room while the talk runs', () => {
    const view = renderPresenter({ initialState: mockSlideState })
    const timing = view.container.querySelector('[data-presenter-slide-timing]')
    expect(timing, 'the header has no per-page clock').toBeTruthy()
    expect(timing!.textContent).toContain(t('workspace.presentation_slide_elapsed', { value0: '' }).trim())
    expect(timing!.textContent).toMatch(/\d[:]\d\d$/)
    view.unmount()
  })

})
