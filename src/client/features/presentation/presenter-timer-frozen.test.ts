import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import type { PresenterSlideState } from './presenter-view/use-presenter-channel'
import { PresenterWindow } from './presenter-view/presenter-window'
import { usePresenterTimer } from './presenter-view/use-presenter-timer'

// What the presenter window does when the talk is over (L-6). The clock is the record of a show that
// happened, so once the room has gone it has to stop where it stopped — a number still climbing under
// a badge that says "disconnected" reads as a show that never ended.
const receiver = vi.hoisted(() => ({
  current: { state: null as PresenterSlideState | null, connected: false, sendCommand: vi.fn() },
}))

vi.mock('./presenter-view/use-presenter-channel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./presenter-view/use-presenter-channel')>()),
  usePresenterReceiver: () => receiver.current,
}))

function state(startedAt: number): PresenterSlideState {
  return {
    noteTitle: 'Quarterly Review',
    slideIndex: 1,
    subPage: 0,
    step: 0,
    steps: 0,
    slideCount: 3,
    pageCount: 1,
    currentSlideSource: '# Two',
    nextSlideSource: '# Three',
    nextSubPage: 0,
    nextStep: 0,
    notes: 'Thank everyone.',
    startedAt,
  }
}

function TimerProbe({ startedAt, frozen, held }: { startedAt: number; frozen: boolean; held: { seconds: number[] } }) {
  const timer = usePresenterTimer(startedAt, frozen)
  held.seconds.push(timer.elapsedSeconds)
  return null
}

beforeEach(async () => {
  await initI18n()
  receiver.current = { state: null, connected: false, sendCommand: vi.fn() }
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the presenter clock when the room has gone', () => {
  it('counts while the show is running and holds the moment it stopped', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const held = { seconds: [] as number[] }
    const view = renderElement(createElement(TimerProbe, { startedAt: 0, frozen: false, held }))

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(held.seconds.at(-1)).toBe(10)

    act(() => {
      view.rerender(createElement(TimerProbe, { startedAt: 0, frozen: true, held }))
    })
    const heldAt = held.seconds.at(-1)
    act(() => {
      vi.advanceTimersByTime(45_000)
    })
    expect(held.seconds.at(-1), 'a finished show is not still running').toBe(heldAt)
    view.unmount()
  })

  it('starts over for the next show rather than resuming the frozen number', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const held = { seconds: [] as number[] }
    const view = renderElement(createElement(TimerProbe, { startedAt: 0, frozen: true, held }))
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(held.seconds.at(-1)).toBe(0)

    vi.setSystemTime(120_000)
    act(() => {
      view.rerender(createElement(TimerProbe, { startedAt: 120_000, frozen: false, held }))
    })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(held.seconds.at(-1)).toBe(5)
    view.unmount()
  })
})

describe('the presenter window after the show closed', () => {
  it('holds the elapsed time, says it is disconnected, and stops offering the two controls that would change it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    receiver.current = { state: state(0), connected: true, sendCommand: vi.fn() }
    const view = renderElement(createElement(PresenterWindow))

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    const running = view.container.querySelector('[data-presenter-clock]')?.textContent?.trim() ?? ''
    expect(running).toBe('00:30')

    act(() => {
      receiver.current = { state: state(0), connected: false, sendCommand: vi.fn() }
      view.rerender(createElement(PresenterWindow))
    })
    act(() => {
      vi.advanceTimersByTime(45_000)
    })

    const held = view.container.querySelector('[data-presenter-clock]')?.textContent?.trim() ?? ''
    const disabled = [...view.container.querySelectorAll<HTMLButtonElement>('header button[disabled]')]
      .map((button) => button.getAttribute('aria-label') ?? '')
    expect(held, 'the clock reads the show that ended, not the wall').toBe('00:30')
    expect(disabled, 'a control that cannot do anything must not look pressable')
      .toEqual([t('workspace.presentation_timer_pause'), t('workspace.presentation_timer_reset')])
    expect(view.container.textContent).toContain(t('workspace.presentation_disconnected'))
    view.unmount()
  })
})
