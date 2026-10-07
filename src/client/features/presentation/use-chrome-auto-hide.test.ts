import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CHROME_IDLE_MS, useChromeAutoHide } from './use-chrome-auto-hide'

let frame: (() => void) | null = null
let frames = 0
let armed: number[] = []
let renders = 0

beforeEach(() => {
  frame = null
  frames = 0
  armed = []
  renders = 0
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frame = callback
    frames += 1
    return frames
  })
  vi.stubGlobal('cancelAnimationFrame', () => { frame = null })
  const schedule = window.setTimeout.bind(window)
  vi.spyOn(window, 'setTimeout').mockImplementation((handler: TimerHandler, timeout?: number) => {
    armed.push(timeout ?? 0)
    return schedule(handler, timeout)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function Host({ active = true }: { active?: boolean }) {
  const hidden = useChromeAutoHide(active)
  renders += 1
  return createElement('span', { 'data-hidden': String(hidden) })
}

function chromeHidden(view: RenderedElement): boolean {
  return view.container.querySelector('span')?.getAttribute('data-hidden') === 'true'
}

function move(count = 1): void {
  act(() => {
    for (let index = 0; index < count; index++) window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
  })
}

function press(key: string): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

function paintFrame(): void {
  const paint = frame
  frame = null
  act(() => { paint?.() })
}

function quietFor(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

function fadeArms(): number {
  return armed.filter((ms) => ms === CHROME_IDLE_MS).length
}

describe('useChromeAutoHide — what wakes the chrome', () => {
  it('lifts the fade on the next pointer move', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    quietFor(CHROME_IDLE_MS)
    expect(chromeHidden(view)).toBe(true)

    move()
    paintFrame()
    expect(chromeHidden(view)).toBe(false)
    view.unmount()
  })

  it('lifts it on a key press too, which is how a presenter without a mouse gets the controls back', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    quietFor(CHROME_IDLE_MS)
    expect(chromeHidden(view)).toBe(true)

    press('ArrowRight')
    paintFrame()
    expect(chromeHidden(view)).toBe(false)
    view.unmount()
  })

  it('hides again once the talk has been quiet for the idle window', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    expect(chromeHidden(view)).toBe(false)
    quietFor(CHROME_IDLE_MS)
    expect(chromeHidden(view)).toBe(true)
    view.unmount()
  })

  it('never fades once the show stops asking for it, whatever the pointer does', () => {
    const view = renderElement(createElement(Host, { active: false }))
    quietFor(CHROME_IDLE_MS * 3)
    move()
    paintFrame()
    quietFor(CHROME_IDLE_MS * 3)
    expect(chromeHidden(view)).toBe(false)
    view.unmount()
  })

  it('brings the chrome back when the show stops asking while it is faded', () => {
    const view = renderElement(createElement(Host, { active: true }))
    paintFrame()
    quietFor(CHROME_IDLE_MS)
    expect(chromeHidden(view)).toBe(true)

    view.rerender(createElement(Host, { active: false }))
    expect(chromeHidden(view)).toBe(false)
    view.unmount()
  })
})

describe('useChromeAutoHide — the rate it wakes at', () => {
  it('schedules one wake per frame, not one per pointer event', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    expect(frames).toBe(1)

    move(200)
    expect(frames, 'every pointer event scheduled its own frame').toBe(2)
    paintFrame()
    expect(fadeArms()).toBe(2)
    view.unmount()
  })

  it('restarts the idle window from the last move', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()

    quietFor(1000)
    move()
    paintFrame()
    quietFor(2000)
    expect(chromeHidden(view), 'the fade kept the deadline the first move set').toBe(false)

    quietFor(1000)
    expect(chromeHidden(view), 'and it never hid at all').toBe(true)
    view.unmount()
  })
})

describe('useChromeAutoHide — what a stretch of movement is allowed to change', () => {
  it('commits nothing for a move that only kept the chrome up', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    const committed = renders

    for (let index = 0; index < 30; index++) {
      move()
      paintFrame()
    }
    expect(renders).toBe(committed)
    view.unmount()
  })

  it('still commits the one flip that is real: the chrome going back up', () => {
    const view = renderElement(createElement(Host, null))
    paintFrame()
    quietFor(CHROME_IDLE_MS)
    const faded = renders

    move()
    paintFrame()
    expect(renders).toBe(faded + 1)
    expect(chromeHidden(view)).toBe(false)
    view.unmount()
  })
})
