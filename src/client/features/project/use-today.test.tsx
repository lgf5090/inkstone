import { act, createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useToday } from './use-today'

let view: RenderedElement

function Probe(): ReactElement {
  const today = useToday()
  return createElement('output', { 'data-today': '' }, String(today))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 15, 23, 59, 50))
})

afterEach(() => {
  view?.unmount()
  vi.useRealTimers()
})

describe('useToday', () => {
  it('advances the local day after midnight without a data refresh', async () => {
    await act(async () => { view = renderElement(createElement(Probe)) })
    const output = view.container.querySelector('output')!
    const first = new Date(2026, 10, 15)
    first.setHours(0, 0, 0, 0)
    expect(output.textContent).toBe(String(first.getTime()))
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    const second = new Date(2026, 10, 16)
    second.setHours(0, 0, 0, 0)
    expect(output.textContent).toBe(String(second.getTime()))
  })
})
