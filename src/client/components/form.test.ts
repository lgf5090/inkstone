import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Slider } from './form'

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
