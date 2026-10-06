/**
 * The browser's own full screen is the one thing in a show the presenter asks for and cannot see
 * failing: a refused request leaves the projector looking almost exactly as it did. So the refusal has
 * to be said out loud when it was the presenter who pressed for it, and said in the log when it was
 * the show reaching for it on its own.
 */
import { act, createElement, type RefObject } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useFullscreenToggle } from './use-fullscreen-toggle'

beforeAll(async () => {
  await initI18n()
})

function Host({ open, panelRef }: { open: boolean; panelRef: RefObject<HTMLDivElement | null> }) {
  const { isFullscreen, toggleFullscreen } = useFullscreenToggle(open, panelRef)
  return createElement('button', { type: 'button', onClick: toggleFullscreen, 'data-fullscreen': String(isFullscreen) }, 'toggle')
}

let warnings: unknown[][] = []

function mount(open: boolean, prepare?: (panel: HTMLDivElement) => void): { view: RenderedElement; panel: HTMLDivElement } {
  const panel = document.createElement('div')
  document.body.append(panel)
  // A plain object is the ref the hook reads: `renderElement` flushes its own effects through `act`,
  // so the mount-time layout effect that reaches for the full screen runs with the panel in place.
  const panelRef = { current: panel }
  prepare?.(panel)
  const view = renderElement(createElement(Host, { open, panelRef }))
  return { view, panel }
}

function press(view: RenderedElement): void {
  act(() => {
    view.container.querySelector('button')?.click()
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...rest: unknown[]) => { warnings.push(rest) })
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('useFullscreenToggle — a refused full screen', () => {
  it('tells the presenter when the request they pressed for is refused', async () => {
    const { view, panel } = mount(false)
    panel.requestFullscreen = () => Promise.reject(new Error('blocked'))

    press(view)
    await settle()

    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('workspace.presentation_fullscreen_denied'))
    expect(useUi.getState().toasts.at(-1)?.tone).toBe('warning')
    expect(warnings.length).toBe(1)
    expect(String(warnings[0]?.[0])).toContain('[inkstone]')
  })

  it('names a browser that has no full screen at all, when asked for it', async () => {
    const { view } = mount(false)
    expect(typeof document.createElement('div').requestFullscreen).toBe('undefined')

    press(view)
    await settle()

    expect(useUi.getState().toasts).toHaveLength(1)
    expect(warnings.length).toBe(1)
  })

})

// The show reaches for the full screen itself the moment it opens, inside the gesture that opened
// it. A refusal there is not something the presenter did, and a talk should not start with an
// apology — the log carries it and the button keeps telling the truth about the state.
describe('useFullscreenToggle — what the show does not say out loud', () => {
  it('keeps the automatic attempt at the start of a show out of the presenter’s way', async () => {
    const { view } = mount(true)
    await settle()

    expect(useUi.getState().toasts).toHaveLength(0)
    expect(warnings.length).toBe(1)
    view.unmount()
  })

  it('stays quiet when the browser says yes', async () => {
    const { view } = mount(true, (panel) => {
      panel.requestFullscreen = () => {
        Object.defineProperty(document, 'fullscreenElement', { value: panel, configurable: true })
        document.dispatchEvent(new Event('fullscreenchange'))
        return Promise.resolve()
      }
    })
    await settle()

    expect(view.container.querySelector('button')?.getAttribute('data-fullscreen')).toBe('true')
    expect(useUi.getState().toasts).toHaveLength(0)
    expect(warnings).toHaveLength(0)
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    view.unmount()
  })
})
