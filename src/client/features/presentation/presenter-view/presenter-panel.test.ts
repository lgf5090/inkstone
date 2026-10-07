import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement } from '../../../lib/test-render'
import { PresenterPanel } from './presenter-panel'
import type { PresenterSlideState } from './use-presenter-channel'

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const STATE: PresenterSlideState = {
  noteTitle: 'Project Architecture',
  slideTitles: [],
  slideIndex: 1,
  subPage: 0,
  step: 0,
  steps: 0,
  slideCount: 4,
  pageCount: 1,
  currentSlideSource: '# Core Pillars\n\n- Security\n- Performance',
  nextSlideSource: '# Roadmap\n\nQ4 Deliverables',
  nextStep: 0,
  notes: 'Emphasize zero overhead and deterministic fallbacks.',
  startedAt: 135_000,
}

function renderPanel(overrides: Partial<Parameters<typeof PresenterPanel>[0]> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(200_000)
  const rendered = renderElement(createElement(PresenterPanel, {
    state: STATE,
    chromeHidden: false,
    occluded: false,
    onClose: vi.fn(),
    ...overrides,
  }))
  return rendered
}

describe('PresenterPanel — what the speaker reads', () => {
  it('shows the page the projector has not reached, the notes of the one it is on, and this show’s clock', () => {
    const { container, unmount } = renderPanel()
    const panel = container.querySelector('[data-presenter-panel]')
    expect(panel?.textContent, 'the panel is the console: the next page and the notes have to be in it').toContain('Roadmap')
    expect(panel?.textContent).toContain('Emphasize zero overhead and deterministic fallbacks.')
    expect(panel?.textContent, 'the elapsed time the panel shows is the show’s own, not this mount’s').toContain('01:05')
    expect(container.textContent, 'the projector already fills the screen with the current page').not.toContain('Core Pillars')
    unmount()
  })

  it('names itself so a speaker at the keyboard knows what the column is', () => {
    const { container, unmount } = renderPanel()
    const panel = container.querySelector('[data-presenter-panel]')
    expect(panel?.getAttribute('aria-label')).toBe(t('workspace.presentation_presenter_panel'))
    expect(panel?.tagName).toBe('ASIDE')
    unmount()
  })

  it('goes out of reach with the rest of the chrome, and while the grid is laid over the show', () => {
    const { container, unmount } = renderPanel()
    expect(container.querySelector('[data-presenter-panel]')?.hasAttribute('inert'), 'a reachable panel while the show is idle is a focus stop nobody asked for').toBe(false)
    unmount()

    const faded = renderPanel({ chromeHidden: true })
    expect(faded.container.querySelector('[data-presenter-panel]')?.hasAttribute('inert')).toBe(true)
    faded.unmount()

    const covered = renderPanel({ occluded: true })
    expect(covered.container.querySelector('[data-presenter-panel]')?.hasAttribute('inert')).toBe(true)
    covered.unmount()
  })

  it('closes from its own button, so a speaker who got the window back can put the panel away', () => {
    const onClose = vi.fn()
    const { container, unmount } = renderPanel({ onClose })
    const close = [...container.querySelectorAll('[data-presenter-panel] button')].at(-1)
    expect(close, 'the panel needs a keyboard-reachable way to be dismissed').toBeDefined()
    act(() => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
  })
})
