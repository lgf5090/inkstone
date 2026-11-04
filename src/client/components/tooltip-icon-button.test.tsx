// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../lib/test-render'
import { TooltipIconButton } from './tooltip-icon-button'

let view: RenderedElement | null = null
let rect: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 24,
    height: 24,
    top: 10,
    left: 10,
    right: 34,
    bottom: 34,
    x: 10,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  view?.unmount()
  view = null
  rect.mockRestore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function render(props: Parameters<typeof TooltipIconButton>[0]): void {
  view = renderElement(createElement(TooltipIconButton, props, createElement('span', null, 'x')))
}

function hover(): void {
  const holder = view?.container.querySelector('[data-tooltip-button]')
  expect(holder).not.toBeNull()
  const listener = holder!.parentElement
  expect(listener).not.toBeNull()
  act(() => {
    listener!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  act(() => {
    vi.advanceTimersByTime(500)
  })
}

function tooltip(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]')
}

describe('TooltipIconButton', () => {
  it('keeps the accessible name on the button and shows it as a tooltip in a body portal', () => {
    render({ label: 'Attach files', onClick: () => {} })
    const button = view!.container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('Attach files')
    hover()
    const tip = tooltip()
    expect(tip?.textContent).toContain('Attach files')
    expect(tip?.parentElement).toBe(document.body)
  })

  it('explains a disabled control instead of leaving it silent', () => {
    render({ label: 'Stop recording', disabled: true, disabledHint: 'Saving, try again in a moment' })
    const button = view!.container.querySelector('button')
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-label')).toBe('Stop recording')
    hover()
    expect(tooltip()?.textContent).toContain('Saving, try again in a moment')
  })

  it('passes the pressed state through to the button', () => {
    render({ label: 'Focus mode', active: true })
    expect(view!.container.querySelector('button')?.getAttribute('aria-pressed')).toBe('true')
  })
})
