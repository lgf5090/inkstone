import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { buildAudienceItems } from './presentation-context-menu'
import { menuOptions } from './presentation-menu-options.test-helpers'
import { PresentationControls, type PresentationControlsProps } from './presentation-controls'

installTestGlobals()

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
})

function props(overrides: Partial<PresentationControlsProps> = {}): PresentationControlsProps {
  return {
    exporting: false,
    slideIndex: 1,
    slideCount: 5,
    subPage: 0,
    pageCount: 1,
    step: 0,
    steps: 0,
    isFullscreen: false,
    railOpen: false,
    overview: false,
    following: false,
    followLost: false,
    audienceFollowing: false,
    audienceViewers: 0,
    chromeHidden: false,
    occluded: false,
    compact: false,
    overflowItems: [],
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToggleRail: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleFollowing: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onToggleAudience: vi.fn(),
    onOpenPresenter: vi.fn(),
    onExport: vi.fn(),
    onExportImages: vi.fn(),
    onExportHandout: vi.fn(),
    onExportHtml: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

const control = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

// N-34: the audience control says which of the two it would do, on the bar and behind the phone's door.
// A presenter who cannot tell whether people are already following will start a second show.
describe('PresentationControls — letting an audience in', () => {
  it('offers the invitation while nobody is following', () => {
    const onToggleAudience = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, props({ onToggleAudience })))
    const button = control(container, t('workspace.presentation_audience_follow'))
    expect(button, 'the audience control is not reachable by name').toBeTruthy()
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    button?.click()
    expect(onToggleAudience).toHaveBeenCalledTimes(1)
  })

  it('offers the way out once they are', () => {
    const onToggleAudience = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, props({ audienceFollowing: true, onToggleAudience })))
    expect(control(container, t('workspace.presentation_audience_follow')), 'the row did not change its name').toBeNull()
    const stop = control(container, t('workspace.presentation_audience_stop'))
    expect(stop?.getAttribute('aria-pressed')).toBe('true')
    stop?.click()
    expect(onToggleAudience).toHaveBeenCalledTimes(1)
  })

  it('carries the audience row through the phone door, named by the same two strings', () => {
    const onToggleAudience = vi.fn()
    const items = buildAudienceItems(menuOptions({ audienceFollowing: true, onToggleAudience }))
    renderElement(createElement(PresentationControls, props({ compact: true, overflowItems: items, onToggleAudience })))
    act(() => { document.querySelector<HTMLElement>('[data-presentation-overflow]')?.click() })
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find((item) => item.textContent?.includes(t('workspace.presentation_audience_stop')))
    if (!row) throw new Error('the door has no audience row')
    // The row is a checkbox, not a command: a door that cannot tell the presenter they are already
    // letting people in is how a second show gets started by accident.
    expect(row.getAttribute('role'), 'the audience row is not a checkbox').toBe('menuitemcheckbox')
    expect(row.getAttribute('aria-checked'), 'the row does not report the running show').toBe('true')
    act(() => { row.click() })
    expect(onToggleAudience).toHaveBeenCalledTimes(1)
  })

  // PR-M7: the number belongs on the control that already speaks about the room, not on a fourth
  // surface the presenter has to know to look at.
  it('marks how many browsers came in, on the control that is already there', () => {
    const { container } = renderElement(createElement(PresentationControls, props({ audienceFollowing: true, audienceViewers: 3, onToggleAudience: vi.fn() })))
    expect(container.querySelector('[data-audience-count]')?.textContent).toBe('3')
    expect(control(container, t('workspace.presentation_audience_stop')), 'the number does not become the control name').toBeTruthy()
  })

  it('says nothing while the room is empty, and nothing after the room is let go', () => {
    const empty = renderElement(createElement(PresentationControls, props({ audienceFollowing: true, audienceViewers: 0, onToggleAudience: vi.fn() })))
    expect(empty.container.querySelector('[data-audience-count]')).toBeNull()
    empty.unmount()

    const notFollowing = renderElement(createElement(PresentationControls, props({ audienceFollowing: false, audienceViewers: 4, onToggleAudience: vi.fn() })))
    expect(notFollowing.container.querySelector('[data-audience-count]'), 'a number from a show that is not running is not a fact').toBeNull()
    notFollowing.unmount()
  })

  it('caps the mark instead of widening the bar', () => {
    const { container } = renderElement(createElement(PresentationControls, props({ audienceFollowing: true, audienceViewers: 120, onToggleAudience: vi.fn() })))
    expect(container.querySelector('[data-audience-count]')?.textContent).toBe('99+')
  })
})
