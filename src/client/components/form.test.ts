import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Segmented, Slider, commitOnEnter } from './form'

const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderSlider(onChange: (value: number) => void, value = 13) {
  act(() => root.render(createElement(Slider, { label: 'Size', value, min: 8, max: 100, step: 1, onChange })))
  return host.querySelector<HTMLInputElement>('input[type="range"]')!
}

function drag(input: HTMLInputElement, next: number) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, String(next))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function dragTo(input: HTMLInputElement, next: number) {
  await act(async () => {
    drag(input, next)
  })
}

async function release(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new Event('pointerup', { bubbles: true }))
  })
}

describe('Slider', () => {
  it('coalesces a burst of steps into one write per frame', async () => {
    const onChange = vi.fn()
    const input = renderSlider(onChange)
    act(() => {
      drag(input, 20)
      drag(input, 30)
      drag(input, 40)
    })
    expect(onChange).not.toHaveBeenCalled()
    await act(() => nextFrame())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(40)
  })

  it('keeps showing the dragged value while the owner has not caught up', async () => {
    const input = renderSlider(vi.fn())
    await dragTo(input, 77)
    await act(() => nextFrame())
    expect(input.value).toBe('77')
    expect(input.getAttribute('aria-valuetext')).toBe('77')
    expect(host.textContent).toContain('77')
  })

  it('commits the pending step on release without writing twice', async () => {
    const onChange = vi.fn()
    const input = renderSlider(onChange)
    await dragTo(input, 55)
    await release(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(55)
    await act(() => nextFrame())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('writes again for the next drag after a release', async () => {
    const onChange = vi.fn()
    const input = renderSlider(onChange)
    await dragTo(input, 30)
    await release(input)
    await dragTo(input, 45)
    await act(() => nextFrame())
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([30, 45])
  })

  it('drops a pending commit when unmounted mid-drag', async () => {
    const onChange = vi.fn()
    const input = renderSlider(onChange)
    act(() => {
      drag(input, 60)
    })
    act(() => root.unmount())
    await nextFrame()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('commitOnEnter', () => {
  it('cancels the Enter before committing so it cannot answer a dialog it just opened', () => {
    const calls: string[] = []
    const enter = { key: 'Enter', preventDefault: () => calls.push('prevent') } as unknown as Parameters<typeof commitOnEnter>[0]
    expect(commitOnEnter(enter, () => calls.push('commit'))).toBe(true)
    expect(calls).toEqual(['prevent', 'commit'])
  })

  it('leaves every other key to the field', () => {
    const other = { key: 'a', preventDefault: () => undefined } as unknown as Parameters<typeof commitOnEnter>[0]
    expect(commitOnEnter(other, () => undefined)).toBe(false)
  })
})

const MODE_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]

/** The group's own radios, in visual order. */
function renderSegmented(value: string, onChange = vi.fn()): { radios: HTMLButtonElement[]; group: HTMLElement; onChange: ReturnType<typeof vi.fn> } {
  act(() => {
    root.render(createElement(Segmented, { value, options: MODE_OPTIONS, onChange, label: 'Mode' }))
  })
  return {
    radios: [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')],
    group: host.querySelector<HTMLElement>('[role="radiogroup"]')!,
    onChange,
  }
}

function press(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}

describe('Segmented keyboard and roles', () => {
  it('is one named radiogroup', () => {
    const { group, radios } = renderSegmented('week')
    expect(group.getAttribute('aria-label')).toBe('Mode')
    expect(radios).toHaveLength(3)
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    for (const radio of radios) expect(radio.textContent?.trim()).not.toBe('')
  })

  it('keeps only the selected radio in the tab order', () => {
    const { radios } = renderSegmented('week')
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1])
  })

  it('falls back to the first radio as the tab stop when nothing is selected', () => {
    const { radios } = renderSegmented('quarter')
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1])
  })

  it('steps the selection with the arrows, wraps at the ends, and moves the focus with it', () => {
    const { radios, onChange } = renderSegmented('week')
    radios[1]!.focus()
    expect(press(document.activeElement!, 'ArrowRight').defaultPrevented).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith('month')
    expect(document.activeElement).toBe(radios[2])
    press(document.activeElement!, 'ArrowRight')
    expect(onChange).toHaveBeenLastCalledWith('day')
    expect(document.activeElement).toBe(radios[0])
    press(document.activeElement!, 'ArrowLeft')
    expect(onChange).toHaveBeenLastCalledWith('month')
    expect(document.activeElement).toBe(radios[2])
  })

  it('jumps to the ends with Home and End', () => {
    const { radios, onChange } = renderSegmented('week')
    radios[1]!.focus()
    press(document.activeElement!, 'Home')
    expect(onChange).toHaveBeenLastCalledWith('day')
    expect(document.activeElement).toBe(radios[0])
    press(document.activeElement!, 'End')
    expect(onChange).toHaveBeenLastCalledWith('month')
    expect(document.activeElement).toBe(radios[2])
  })

  it('leaves a key the group does not answer to alone', () => {
    const { radios, onChange } = renderSegmented('week')
    radios[1]!.focus()
    const event = press(document.activeElement!, 'ArrowRight')
    expect(event.defaultPrevented).toBe(true)
    const letter = press(document.activeElement!, 'a')
    expect(letter.defaultPrevented).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
