import { createElement } from 'react'
import { initI18n, t } from '../../lib/i18n'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { PresentationControls, type PresentationControlsProps } from './presentation-controls'

installTestGlobals()

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function props(overrides: Partial<PresentationControlsProps>): PresentationControlsProps {
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
    chromeHidden: false,
    occluded: false,
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onToggleRail: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleFollowing: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onOpenPresenter: vi.fn(),
    audienceFollowing: false,
    audienceViewers: 0,
    onToggleAudience: vi.fn(),
    onExport: vi.fn(),
    onExportImages: vi.fn(),
    onExportHandout: vi.fn(),
    onExportHtml: vi.fn(),
    onClose: vi.fn(),
    compact: false,
    overflowItems: [],
    ...overrides,
  }
}

const ON_THE_SECOND_REVEAL = { slideIndex: 2, slideCount: 14, subPage: 1, pageCount: 4, step: 1, steps: 2 }

// N-31's echo: a page that arrives block by block has to say how far it has arrived, in the digits and
// in the announcement both — otherwise the room is told a slide number while the projector shows a
// half-drawn one. These also pin the turn's reach: a page that is still arriving is never the end of
// the show, however late in it, and never the start, however early.
describe('PresentationControls — a page that is still arriving', () => {
  it('prints the reveal as a third number of the same position', () => {
    const { container } = renderElement(createElement(PresentationControls, props(ON_THE_SECOND_REVEAL)))
    const printed = container.querySelector('[data-deck-position]')?.textContent?.trim() ?? ''
    expect(printed).toBe('3 / 14 · 2/4 · 2/3')
  })

  it('speaks the reveal in the one sentence that carries the rest of the position', () => {
    const { container } = renderElement(createElement(PresentationControls, props(ON_THE_SECOND_REVEAL)))
    const spoken = container.querySelector('[aria-live]')?.textContent?.trim() ?? ''
    expect(spoken.match(/\d+/g)).toEqual(['3', '14', '2', '4', '2', '3'])
  })

  it('says nothing about reveals on a page that has none', () => {
    const { container } = renderElement(createElement(PresentationControls, props({ slideIndex: 2, slideCount: 14, subPage: 1, pageCount: 4 })))
    const printed = container.querySelector('[data-deck-position]')?.textContent?.trim() ?? ''
    expect(printed).toBe('3 / 14 · 2/4')
  })

  it('keeps prev alive while there is a reveal to walk back', () => {
    const { container } = renderElement(createElement(PresentationControls, props({ slideIndex: 0, slideCount: 1, subPage: 0, pageCount: 1, step: 1, steps: 2 })))
    const prev = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_prev')}"]`)
    expect(prev?.disabled).toBe(false)
  })

  it('puts next out of reach once the last reveal of the last page of the last slide is on screen', () => {
    const { container } = renderElement(createElement(PresentationControls, props({ slideIndex: 0, slideCount: 1, subPage: 0, pageCount: 1, step: 2, steps: 2 })))
    const next = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    expect(next?.disabled).toBe(true)
  })
})
