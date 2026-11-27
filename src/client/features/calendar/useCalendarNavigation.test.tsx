// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ViewType, type ICalendarApp } from '@dayflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals } from '../../lib/test-render'
import { useCalendarNavigation } from './useCalendarNavigation'

const roots: Root[] = []

function mountNavigation(app: ICalendarApp): () => void {
  function Probe() {
    useCalendarNavigation(app, 'week')
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(createElement(Probe)))
  return () => {
    act(() => root.unmount())
    host.remove()
  }
}

function fakeApp(initialView = ViewType.WEEK, initialDate = new Date(2026, 10, 27)) {
  let view = initialView
  let date = initialDate
  let listener: (() => void) | null = null
  const app = {
    getCurrentView: () => ({ type: view }),
    getCurrentDate: () => date,
    changeView: vi.fn((next: ViewType) => { view = next; listener?.() }),
    setCurrentDate: vi.fn((next: Date) => { date = next; listener?.() }),
    subscribe: vi.fn((next: () => void) => { listener = next; return () => { listener = null } }),
  }
  return { app: app as unknown as ICalendarApp, mocks: app }
}

beforeEach(() => {
  installTestGlobals()
  vi.useFakeTimers()
  window.history.replaceState({}, '', '/calendar?view=week&date=2026-11-27#day')
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('calendar browser navigation', () => {
  it('normalizes a cold deep link without adding history', () => {
    window.history.replaceState({}, '', '/calendar?view=invalid&date=bad')
    const push = vi.spyOn(window.history, 'pushState')
    const { app } = fakeApp()
    const before = window.history.length
    mountNavigation(app)
    expect(window.location.search).toBe('?view=week&date=2026-11-27')
    expect(window.history.length).toBe(before)
    expect(push).not.toHaveBeenCalled()
  })

  it('coalesces a same-frame view and date change into one history entry', () => {
    const { app, mocks } = fakeApp()
    const push = vi.spyOn(window.history, 'pushState')
    const before = window.history.length
    mountNavigation(app)
    act(() => {
      mocks.changeView(ViewType.MONTH)
      mocks.setCurrentDate(new Date(2026, 11, 2))
    })
    act(() => vi.advanceTimersByTime(20))
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(before + 1)
    expect(window.location.search).toBe('?view=month&date=2026-12-02')
    expect(window.location.hash).toBe('#day')
  })

  it('restores view and date on popstate without pushing another entry', () => {
    const { app, mocks } = fakeApp()
    const push = vi.spyOn(window.history, 'pushState')
    mountNavigation(app)
    window.history.pushState({}, '', '/calendar?view=month&date=2026-12-02')
    push.mockClear()
    const before = window.history.length
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(mocks.changeView).toHaveBeenCalledWith(ViewType.MONTH)
    expect(mocks.setCurrentDate).toHaveBeenCalledWith(new Date(2026, 11, 2))
    expect(window.history.length).toBe(before)
    expect(push).not.toHaveBeenCalled()
  })

  it('replaces history during continuous date navigation', () => {
    const { app, mocks } = fakeApp()
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    mountNavigation(app)
    act(() => mocks.setCurrentDate(new Date(2026, 10, 28)))
    act(() => vi.advanceTimersByTime(20))
    act(() => mocks.setCurrentDate(new Date(2026, 10, 29)))
    act(() => vi.advanceTimersByTime(20))
    expect(push).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('?view=week&date=2026-11-29')
  })
})
