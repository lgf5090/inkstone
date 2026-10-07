import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PublicSharePresence } from '@shared/share-presence'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { AudienceView, readAudiencePosition } from './audience-view'

installTestGlobals()

// The viewer's seat, tested apart from the polling that fills it: what is asserted here is which page the
// audience is looking at, whether a press of their own keeps them on it, and what they are told when the
// show stops arriving. The beat itself is `use-audience-presence.test.ts`.
const feed = vi.hoisted(() => ({ current: { state: 'connecting', presence: null } as { state: string; presence: PublicSharePresence | null }, listeners: new Set<() => void>() }))

vi.mock('./use-audience-presence', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAudiencePresence: () => useSyncExternalStore(
      (notify: () => void) => {
        feed.listeners.add(notify)
        return () => {
          feed.listeners.delete(notify)
        }
      },
      () => feed.current,
    ),
  }
})

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
  feed.listeners.clear()
  feed.current = { state: 'connecting', presence: null }
})

const SOURCE = ['# One\n\nFirst body.', '# Two\n\nSecond body.', '# Three\n\nThird body.'].join('\n\n')

function emit(state: string, presence: PublicSharePresence | null) {
  act(() => {
    feed.current = { state, presence }
    for (const notify of feed.listeners) notify()
  })
}

function at(slide: number, page = 0, step = 0): PublicSharePresence {
  return { slide, page, step, updatedAt: 1, title: 'Quarterly Review' }
}

function mount() {
  const view = renderElement(createElement(AudienceView, { slug: 'slug-1', token: 'token-1', source: SOURCE }))
  const root = view.container
  const button = (label: string) => root.querySelector<HTMLButtonElement>(`[data-audience-bar] button[aria-label="${label}"]`)!
  return {
    position: () => root.querySelector('[data-deck-position]')?.textContent?.trim() ?? '',
    state: () => root.querySelector('[data-audience-state]')?.textContent?.trim() ?? '',
    followSwitch: () => root.querySelector<HTMLButtonElement>('[role="switch"]')!,
    pressNext: () => act(() => {
      button(t('workspace.presentation_next')).click()
    }),
    pressPrev: () => act(() => {
      button(t('workspace.presentation_prev')).click()
    }),
    slideText: () => root.querySelector('[data-slide-canvas]')?.textContent ?? '',
    unmount: view.unmount,
  }
}

describe('AudienceView — the page the audience is looking at', () => {
  it('lands where the speaker wrote the show', () => {
    const show = mount()
    emit('live', at(1))
    expect(show.position()).toBe('2 / 3')
    expect(show.slideText()).toContain('Second body')
    show.unmount()
  })

  it('follows the speaker to the next page while the viewer is following', () => {
    const show = mount()
    emit('live', at(1))
    emit('live', at(2))
    expect(show.position()).toBe('3 / 3')
    show.unmount()
  })

  it('holds the page the viewer turned to, and is not dragged back', () => {
    const show = mount()
    emit('live', at(1))
    show.pressNext()
    expect(show.position(), 'a press of their own walks the viewer forward').toBe('3 / 3')
    expect(show.followSwitch().getAttribute('aria-checked')).toBe('false')
    emit('live', at(1))
    expect(show.position(), 'being pulled back to the talk is worse than being behind it').toBe('3 / 3')
    show.unmount()
  })

  it('returns to the live page when the switch is handed back', () => {
    const show = mount()
    emit('live', at(1))
    show.pressPrev()
    expect(show.position()).toBe('1 / 3')
    act(() => {
      show.followSwitch().click()
    })
    expect(show.followSwitch().getAttribute('aria-checked')).toBe('true')
    expect(show.position()).toBe('2 / 3')
    show.unmount()
  })
})

describe('AudienceView — what a viewer is told about the show', () => {
  it('names each of the three states the feed can be in', () => {
    const show = mount()
    expect(show.state()).toBe(t('workspace.presentation_audience_connecting'))
    emit('live', at(0))
    expect(show.state()).toBe(t('workspace.presentation_audience_following'))
    emit('stale', at(0))
    expect(show.state()).toBe(t('workspace.presentation_audience_stale'))
    emit('ended', null)
    expect(show.state(), 'an ended show leaves the last page on the wall').toBe(t('workspace.presentation_audience_ended'))
    show.unmount()
  })

  it('says so when the viewer is live but looking elsewhere', () => {
    const show = mount()
    emit('live', at(0))
    show.pressNext()
    expect(show.state()).toBe(t('workspace.presentation_audience_browsing'))
    show.unmount()
  })

  it('announces the state through a live region', () => {
    const show = mount()
    const region = show.state()
    const node = document.querySelector('[data-audience-state]')
    expect(node?.getAttribute('role')).toBe('status')
    expect(node?.getAttribute('aria-live')).toBe('polite')
    expect(region).not.toBe('')
    show.unmount()
  })
})

describe('AudienceView — the keys the show already answers to', () => {
  it('turns the page on the right arrow and takes the wheel with it', () => {
    const show = mount()
    emit('live', at(1))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(show.position()).toBe('3 / 3')
    expect(show.followSwitch().getAttribute('aria-checked')).toBe('false')
    show.unmount()
  })

  it('jumps to the first slide on Home and the last on End', () => {
    const show = mount()
    emit('live', at(1))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(show.position()).toBe('1 / 3')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(show.position()).toBe('3 / 3')
    show.unmount()
  })

})

describe('AudienceView — a turn that has nowhere to go', () => {
  it('leaves a keystroke the show does not answer to alone', () => {
    const show = mount()
    emit('live', at(1))
    let prevented = false
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      prevented = event.defaultPrevented
    })
    expect(prevented, 'the projector has no fullscreen key for a viewer to press').toBe(false)
    expect(show.position()).toBe('2 / 3')
    show.unmount()
  })

  it('disables the turn that has nothing left to walk', () => {
    const show = mount()
    emit('live', at(0))
    show.pressPrev()
    const disabled = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-audience-bar] button')).filter((button) => button.disabled).length
    expect(disabled, 'at the first page of the first slide the back turn is out of reach').toBe(1)
    show.unmount()
  })

  it('leaves the show alone when a viewer presses past the end of the deck', () => {
    const show = mount()
    emit('live', at(2))
    // The keyboard, not the button: the bar has already taken the last press away, and a turn that walks
    // off the deck is only reachable by a keystroke.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(show.position(), 'the last page of the last slide has nowhere forward to go').toBe('3 / 3')
    expect(show.followSwitch().getAttribute('aria-checked'), 'and a press that goes nowhere is not a decision to leave the talk')
      .toBe('true')
    show.unmount()
  })
})

// The clamps are the ADR's known imprecision written down: what a viewer sees when the speaker's numbers
// do not fit this device. jsdom measures nothing, so the two-page case is asked of the function directly.
// A plan's `steps` is the switch that says the slide arrives in stages; the count itself is blocks per
// page, so these fixtures speak in page ranges the way a measured plan does.
describe('readAudiencePosition — the speaker\'s numbers on the viewer\'s device', () => {
  it('keeps the page the speaker wrote once this device has measured it', () => {
    const twoPages = { pages: [{ from: 0, to: 3, top: 0 }, { from: 3, to: 6, top: 0 }], scales: [1, 1, 1, 1, 1, 1], layout: undefined, steps: [2, 2] }
    expect(readAudiencePosition({ slide: 4, page: 1, step: 2 }, 9, twoPages as never)).toEqual({ index: 4, sub: 1, pageCount: 2, steps: 2, step: 2 })
  })

  it('holds the page rather than snapping to the top while the slide is still unmeasured', () => {
    const written = { slide: 3, page: 2, step: 1 }
    const before = readAudiencePosition(written, 9, undefined)
    expect(before.sub, 'an unmeasured slide is one page, and the clamp reads as that page').toBe(0)
    const after = readAudiencePosition(written, 9, { pages: [{ from: 0, to: 1, top: 0 }, { from: 1, to: 2, top: 0 }, { from: 2, to: 3, top: 0 }], scales: [1, 1, 1], layout: undefined, steps: undefined } as never)
    expect(after.sub, 'the page the speaker wrote arrives as soon as this device knows it exists').toBe(2)
  })

  it('pulls a page and a reveal back onto the deck the viewer has', () => {
    const twoPages = { pages: [{ from: 0, to: 3, top: 0 }, { from: 3, to: 5, top: 0 }], scales: [1, 1, 1, 1, 1], layout: undefined, steps: [2, 1] }
    expect(readAudiencePosition({ slide: 12, page: 9, step: 7 }, 4, twoPages as never)).toEqual({ index: 3, sub: 1, pageCount: 2, steps: 1, step: 1 })
  })

  it('lands on a slide that exists when the deck shrank mid-talk', () => {
    expect(readAudiencePosition({ slide: 6, page: 0, step: 0 }, 2, undefined).index).toBe(1)
    expect(readAudiencePosition({ slide: 6, page: 0, step: 0 }, 0, undefined).index, 'an empty deck has no slide to land on either').toBe(0)
  })
})
