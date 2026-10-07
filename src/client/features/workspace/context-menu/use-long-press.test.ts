import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './use-long-press'

const presses: Array<{ x: number; y: number; tag: string }> = []

function Probe() {
  const { handlers, justLongPressed } = useLongPress((point, target) => {
    presses.push({ x: point.x, y: point.y, tag: (target as HTMLElement).dataset.tag ?? '' })
  })
  return createElement('div', { ...handlers, 'data-tag': 'host', 'data-armed': String(justLongPressed()) })
}

let root: Root
let host: HTMLDivElement

function element(): HTMLElement {
  return host.querySelector<HTMLElement>('[data-tag="host"]')!
}

function touch(type: 'start' | 'move' | 'end', x = 40, y = 60) {
  const event: Record<string, unknown> = {
    bubbles: true,
    cancelable: true,
    touches: type === 'end' ? [] : [{ clientX: x, clientY: y, identifier: 0 }],
    changedTouches: [{ clientX: x, clientY: y, identifier: 0 }],
    preventDefault: () => undefined,
  }
  act(() => {
    // React's synthetic touch events read `touches` and `targetTouches` off the native event.
    Object.assign(event, { targetTouches: type === 'end' ? [] : [{ clientX: x, clientY: y, identifier: 0 }] })
    element().dispatchEvent(new TouchEvent('touch' + type, event as TouchEventInit))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  presses.length = 0
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(Probe))
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.useRealTimers()
})

describe('useLongPress', () => {
  it('opens the menu once the press has been held long enough', () => {
    touch('start')
    vi.advanceTimersByTime(600)
    expect(presses).toHaveLength(1)
    expect(presses[0]).toMatchObject({ x: 40, y: 60 })
  })

  it('does not open for a tap', () => {
    touch('start')
    vi.advanceTimersByTime(200)
    touch('end')
    vi.advanceTimersByTime(1000)
    expect(presses).toHaveLength(0)
  })

  it('does not open again when the held finger keeps pressing', () => {
    touch('start')
    vi.advanceTimersByTime(2000)
    expect(presses).toHaveLength(1)
  })

  it('cancels when the finger wanders, which is a scroll rather than a press', () => {
    touch('start')
    vi.advanceTimersByTime(200)
    touch('move', 90, 60)
    vi.advanceTimersByTime(1000)
    expect(presses).toHaveLength(0)
  })

  it('tolerates a small tremor inside the slop', () => {
    touch('start')
    vi.advanceTimersByTime(200)
    touch('move', 45, 62)
    vi.advanceTimersByTime(500)
    expect(presses).toHaveLength(1)
  })

  it('reports the gesture as already served, so a browser contextmenu does not reopen it', () => {
    touch('start')
    vi.advanceTimersByTime(600)
    touch('end')
    act(() => {
      root.render(createElement(Probe))
    })
    expect(element().dataset.armed).toBe('true')
    vi.advanceTimersByTime(1200)
    act(() => {
      root.render(createElement(Probe))
    })
    expect(element().dataset.armed).toBe('false')
  })

  it('cancels a pending press when the touch is taken away', () => {
    touch('start')
    act(() => {
      element().dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, cancelable: true, touches: [], changedTouches: [] }))
    })
    vi.advanceTimersByTime(1000)
    expect(presses).toHaveLength(0)
  })
})
