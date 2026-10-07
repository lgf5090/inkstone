import { act, createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { initI18n, t } from '../../lib/i18n'
import { CoverAnnouncement, ScreenCover } from './presentation-stage'
import { measureStage, NARROW_STAGE_RATIO, SLIDE_DESIGN_HEIGHT, SLIDE_DESIGN_NARROW_WIDTH, SLIDE_DESIGN_WIDTH, SLIDE_PAD_X, SLIDE_PAD_Y } from './slide-stage'

// The cover's accessible name is a resource string, so the resources have to be loaded for the
// assertion to compare anything but a key against itself.
beforeAll(async () => {
  await initI18n()
})

describe('measureStage', () => {
  it('returns fallback metrics for non-positive dimensions', () => {
    const metrics = measureStage(0, 0)
    expect(metrics.scale).toBe(1)
    expect(metrics.designWidth).toBe(SLIDE_DESIGN_WIDTH)
    expect(metrics.designHeight).toBe(SLIDE_DESIGN_HEIGHT)
    expect(metrics.contentWidth).toBe(SLIDE_DESIGN_WIDTH - SLIDE_PAD_X * 2)
    expect(metrics.contentHeight).toBe(SLIDE_DESIGN_HEIGHT - SLIDE_PAD_Y * 2)
  })

  it('keeps fixed design size and scales up on 1080p viewport', () => {
    const metrics = measureStage(1920, 1080)
    expect(metrics.scale).toBe(1.5)
    expect(metrics.designWidth).toBe(1280)
    expect(metrics.designHeight).toBe(720)
    expect(metrics.contentWidth).toBe(1168)
    expect(metrics.contentHeight).toBe(632)
  })

  it('scales down on smaller screens while preserving fixed 16:9 canvas', () => {
    const metrics = measureStage(640, 360)
    expect(metrics.scale).toBe(0.5)
    expect(metrics.designWidth).toBe(1280)
    expect(metrics.designHeight).toBe(720)
    expect(metrics.contentWidth).toBe(1168)
    expect(metrics.contentHeight).toBe(632)
  })

  it('maintains identical design dimensions when rail opens/closes, preventing cache misses', () => {
    const beforeRail = measureStage(1280, 720)
    const afterRail = measureStage(1064, 720)
    expect(beforeRail.designWidth).toBe(afterRail.designWidth)
    expect(beforeRail.designHeight).toBe(afterRail.designHeight)
    expect(beforeRail.contentWidth).toBe(afterRail.contentWidth)
    expect(beforeRail.contentHeight).toBe(afterRail.contentHeight)
    expect(afterRail.scale).toBe(1064 / 1280)
  })
})

describe('ScreenCover', () => {
  it('renders black cover with modal z-index and calls onClear on click', () => {
    const onClear = vi.fn()
    const view = renderElement(createElement(ScreenCover, { cover: 'black', onClear }))
    const cover = view.container.querySelector('[data-screen-cover="black"]')
    expect(cover).toBeTruthy()
    expect(cover?.className).toContain('z-[var(--z-modal)]')
    expect(cover?.className).toContain('bg-[rgb(0_0_0)]')
    cover?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('renders white cover with modal z-index and calls onClear on click', () => {
    const onClear = vi.fn()
    const view = renderElement(createElement(ScreenCover, { cover: 'white', onClear }))
    const cover = view.container.querySelector('[data-screen-cover="white"]')
    expect(cover).toBeTruthy()
    expect(cover?.className).toContain('z-[var(--z-modal)]')
    expect(cover?.className).toContain('bg-[rgb(255_255_255)]')
    cover?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('intercepts onContextMenu and prevents default to eliminate native menu on screen cover', () => {
    const onClear = vi.fn()
    const view = renderElement(createElement(ScreenCover, { cover: 'black', onClear }))
    const cover = view.container.querySelector('[data-screen-cover="black"]')
    expect(cover).toBeTruthy()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    // What stopping propagation buys is the menu behind the cover never hearing the press, so that
    // is what gets asserted — the flag itself is not readable on a dispatched event.
    let reachedAncestor = false
    const guard = () => { reachedAncestor = true }
    document.body.addEventListener('contextmenu', guard)
    cover?.dispatchEvent(event)
    document.body.removeEventListener('contextmenu', guard)
    expect(event.defaultPrevented).toBe(true)
    expect(reachedAncestor).toBe(false)
    expect(onClear).not.toHaveBeenCalled()
    view.unmount()
  })
})

// N-14: the cover is a control the speaker presses, not a painted rectangle that happens to answer
// clicks. Its name comes from the resources — the same surface has to read the same thing in either
// language — and it is the one thing a keyboard user can act on while the projector is covered.
describe('ScreenCover — a control, not a painted rectangle', () => {
  it('is a real button that names itself from the resources', () => {
    const view = renderElement(createElement(ScreenCover, { cover: 'black', onClear: vi.fn() }))
    const cover = document.querySelector('[data-screen-cover="black"]')
    expect(cover?.tagName).toBe('BUTTON')
    expect(cover?.getAttribute('type')).toBe('button')
    expect(cover?.getAttribute('aria-label')).toBe(t('workspace.presentation_blackout'))
    view.unmount()
  })

  it('takes the keyboard when it takes the screen', () => {
    const view = renderElement(createElement(ScreenCover, { cover: 'white', onClear: vi.fn() }))
    expect(document.activeElement).toBe(document.querySelector('[data-screen-cover="white"]'))
    view.unmount()
  })
})

// The reason this lives in a live region rather than in the button: covering the screen and uncovering
// it are the two things a flat colour cannot show, and the button is gone by the time the second one
// happens.
describe('CoverAnnouncement — the change a flat colour hides', () => {
  const announced = () => document.querySelector('[role="status"]')?.textContent?.trim() ?? ''

  it('says nothing when nothing has changed', () => {
    const view = renderElement(createElement(CoverAnnouncement, { cover: null }))
    expect(announced()).toBe('')
    view.unmount()
  })

  it('names the cover when the projector goes flat', () => {
    const view = renderElement(createElement(CoverAnnouncement, { cover: null }))
    act(() => { view.rerender(createElement(CoverAnnouncement, { cover: 'black' })) })
    expect(announced()).toContain(t('workspace.presentation_blackout'))
    view.unmount()
  })

  it('says the cover is lifted when the screen comes back', () => {
    const view = renderElement(createElement(CoverAnnouncement, { cover: 'white' }))
    act(() => { view.rerender(createElement(CoverAnnouncement, { cover: null })) })
    expect(announced()).toContain(t('workspace.presentation_cover_off'))
    view.unmount()
  })
})

// PR-M6: what a phone held upright is shown. The stage is the only place that decides how big the type
// ends up, and the whole claim of the narrow canvas is that the same glass carries bigger words.
describe('measureStage — the canvas a stage gets', () => {
  it('keeps a window and a projector on the sixteen-by-nine design', () => {
    const wide = measureStage(1600, 1000)
    expect(wide.designWidth).toBe(SLIDE_DESIGN_WIDTH)
    expect(wide.designHeight).toBe(SLIDE_DESIGN_HEIGHT)
    expect(wide.scale).toBeCloseTo(Math.min(1600 / SLIDE_DESIGN_WIDTH, 1000 / SLIDE_DESIGN_HEIGHT), 8)
  })

  it('does not flip for a handset turned sideways', () => {
    expect(measureStage(780, 390).designWidth).toBe(SLIDE_DESIGN_WIDTH)
  })

  it('draws a taller, narrower canvas for a phone held up', () => {
    const phone = measureStage(420, 840)
    expect(phone.designWidth).toBe(SLIDE_DESIGN_NARROW_WIDTH)
    expect(phone.designHeight).toBe(1280)
    expect(phone.contentWidth).toBe(SLIDE_DESIGN_NARROW_WIDTH - SLIDE_PAD_X * 2)
    expect(phone.contentHeight).toBe(1280 - SLIDE_PAD_Y * 2)
  })

  it('puts type twice as large on that glass, which is the point of the round', () => {
    const phone = measureStage(420, 840)
    const asIfSixteenNine = 420 / SLIDE_DESIGN_WIDTH
    expect(phone.scale / asIfSixteenNine).toBeCloseTo(2, 8)
  })

  it('fills the glass rather than letterboxing it', () => {
    const phone = measureStage(420, 840)
    expect(phone.designWidth * phone.scale).toBeCloseTo(420, 6)
    expect(phone.designHeight * phone.scale).toBeCloseTo(840, 6)
  })

  it('flips on at the ratio it names, and not before', () => {
    expect(NARROW_STAGE_RATIO).toBe(1.2)
    expect(measureStage(500, 600).designWidth).toBe(SLIDE_DESIGN_NARROW_WIDTH)
    expect(measureStage(500, 599).designWidth).toBe(SLIDE_DESIGN_WIDTH)
  })
})
