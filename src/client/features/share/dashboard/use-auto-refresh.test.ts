// @vitest-environment jsdom
/**
 * The cadence, on its own.
 *
 * Auto-refresh is the one part of the dashboard that keeps working after the render is done, and each
 * way it can go wrong is invisible until it is expensive: a timer per mount that stacks asks, a hidden
 * tab that keeps paying for a screen nobody is looking at, or a timer that outlives the component it
 * belonged to. These cases drive the clock by hand and count what the clock produced.
 */
import { act, createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { renderElement, type RenderedElement } from "../../../lib/test-render"
import { AUTO_REFRESH_MS } from "./constants"
import { useAutoRefresh } from "./use-auto-refresh"

function Probe({ enabled, onTick, isBusy }: {
  enabled: boolean
  onTick: () => void
  isBusy: () => boolean
}) {
  useAutoRefresh({ enabled, refresh: onTick, isBusy })
  return null
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true })
}

function visibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"))
}

let rendered: RenderedElement | null = null
let tick: Mock<() => void>
let busy = false

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  setHidden(false)
  busy = false
  tick = vi.fn()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.useRealTimers()
})

describe("the dashboard's cadence", () => {
  it("asks on the interval when it is on, and never when it is off", async () => {
    rendered = renderElement(createElement(Probe, { enabled: false, onTick: tick, isBusy: () => busy }))
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 3) })
    expect(tick).not.toHaveBeenCalled()
    rendered.unmount()
    rendered = null

    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 3) })
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it("skips a tick while a request is still on the wire, and never stacks one", async () => {
    busy = true
    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 3) })
    expect(tick).not.toHaveBeenCalled()

    busy = false
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS) })
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it("keeps one timer across renders, so a redraw does not add an ask", async () => {
    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))
    for (const enabled of [true, true, true]) {
      rendered.rerender(createElement(Probe, { enabled, onTick: tick, isBusy: () => busy }))
    }
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS) })
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it("stops while the tab is hidden and reads once the moment it is back", async () => {
    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))

    setHidden(true)
    visibilityChange()
    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 4) })
    expect(tick).not.toHaveBeenCalled()

    setHidden(false)
    visibilityChange()
    await act(async () => {})
    expect(tick).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS) })
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it("clears the timer when the component goes away", async () => {
    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))
    rendered.unmount()
    rendered = null

    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 3) })
    expect(tick).not.toHaveBeenCalled()
  })

  it("turns the cadence off without waiting for the interval to come round", async () => {
    rendered = renderElement(createElement(Probe, { enabled: true, onTick: tick, isBusy: () => busy }))
    rendered.rerender(createElement(Probe, { enabled: false, onTick: tick, isBusy: () => busy }))

    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 2) })
    expect(tick).not.toHaveBeenCalled()
  })
})
