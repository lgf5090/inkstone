import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useVirtualList, virtualRange } from './virtual-list'

describe('virtual list range', () => {
  it('includes overscan around the measured viewport', () => {
    const offsets = [0, 40, 80, 120, 160, 200, 240, 280]
    expect(virtualRange(offsets, 80, 80, 2)).toEqual({ start: 0, end: 6, offset: 0, bottom: 40, total: 280 })
  })

  it('keeps the range bounded at both edges', () => {
    const offsets = [0, 40, 80, 120, 160, 200]
    expect(virtualRange(offsets, 0, 40, 1)).toEqual({ start: 0, end: 2, offset: 0, bottom: 120, total: 200 })
    expect(virtualRange(offsets, 180, 40, 1)).toEqual({ start: 3, end: 5, offset: 120, bottom: 0, total: 200 })
  })

  it('returns an empty range for an empty list', () => {
    expect(virtualRange([0], 0, 100, 5)).toEqual({ start: 0, end: 0, offset: 0, bottom: 0, total: 0 })
  })

  it('updates its window from the scroll container', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    function Probe() {
      const list = useVirtualList(100, 64, 'probe')
      return createElement('div', { ref: list.containerRef, 'data-testid': 'list' }, `${list.start}:${list.end}`)
    }
    await act(async () => root.render(createElement(Probe)))
    const list = host.querySelector<HTMLElement>('[data-testid="list"]')!
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 })
    await act(async () => {
      Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 6_400 })
      list.dispatchEvent(new Event('scroll'))
    })
    expect(list.textContent).toBe('93:100')
    await act(async () => root.unmount())
    host.remove()
  })
})
