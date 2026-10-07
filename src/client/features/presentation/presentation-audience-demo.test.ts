import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { buildAudienceItems } from './presentation-context-menu'
import { menuOptions } from './presentation-menu-options.test-helpers'
import { PresentationControls } from './presentation-controls'

installTestGlobals()

// The demo edition has no server, so it has no link to hand out. ADR-0006 asks for that to be said rather
// than left out, and these two rows are the whole of it: no door on the bar, one explanation behind the
// phone's door.
vi.mock('../../lib/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runtime')>()),
  IS_DEMO_MODE: true,
}))

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the demo edition — audience follow is stated, not silently missing', () => {
  it('takes the invitation off the projector bar', () => {
    const view = renderElement(createElement(PresentationControls, {
      ...audienceCapsuleProps(),
    }))
    expect(view.container.querySelector('[data-audience-toggle]'), 'a demo presenter is not offered a door that cannot open').toBeNull()
    view.unmount()
  })

  it('says why behind the door', () => {
    const items = buildAudienceItems(menuOptions({ audienceFollowing: false, onToggleAudience: vi.fn() }))
    expect(items).toHaveLength(1)
    expect(items[0]?.disabled, 'the row explains itself instead of doing something').toBe(true)
    expect(items[0]?.label).toBe(t('workspace.presentation_audience_unavailable'))

    const view = renderElement(createElement(PresentationControls, {
      ...audienceCapsuleProps(),
      compact: true,
      overflowItems: items,
    }))
    act(() => {
      view.container.querySelector<HTMLElement>('[data-presentation-overflow]')?.click()
    })
    const row = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((item) => item.textContent?.includes(t('workspace.presentation_audience_unavailable')))
    expect(row, 'the door has no word about audience follow').toBeTruthy()
    expect(row?.disabled).toBe(true)
    view.unmount()
  })
})

/** The capsule as the show hands it over, with every press counted nowhere. */
function audienceCapsuleProps() {
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
  }
}
