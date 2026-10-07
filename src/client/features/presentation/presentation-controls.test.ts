import { act, createElement } from 'react'
import { initI18n, t, type MessageKey } from '../../lib/i18n'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installTestGlobals, renderElement } from '../../lib/test-render'
import { menuOptions } from './presentation-menu-options.test-helpers'
import { DeckExportProgress, PresentationControls, PresentationExitConfirm, SlideProgress, type PresentationControlsProps } from './presentation-controls'
import { buildPresentationOverflowItems } from './presentation-context-menu'

installTestGlobals()

// The toggle is found by the message it shows, which only exists once the locale has loaded.
beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PresentationControls', () => {
  const defaultProps = {
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
    exporting: false,
    onExport: vi.fn(),
    onExportImages: vi.fn(),
    onExportHandout: vi.fn(),
    onExportHtml: vi.fn(),
    onClose: vi.fn(),
    compact: false,
    overflowItems: [],
  }

  it('renders presenter console button and triggers onOpenPresenter when clicked', () => {
    const onOpenPresenter = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, { ...defaultProps, onOpenPresenter }))
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_presenter')}"]`)
    expect(button).toBeTruthy()
    button?.click()
    expect(onOpenPresenter).toHaveBeenCalledTimes(1)
  })

  it('renders control groups with isolating separators', () => {
    const { container } = renderElement(createElement(PresentationControls, defaultProps))
    const chrome = container.querySelector('[data-presentation-chrome]')
    expect(chrome).toBeTruthy()

    const dividers = chrome?.querySelectorAll('span[aria-hidden="true"].w-px')
    expect(dividers?.length).toBe(3)
  })

  it('disables prev button at the start of deck', () => {
    const { container } = renderElement(createElement(PresentationControls, { ...defaultProps, slideIndex: 0, subPage: 0 }))
    const buttons = container.querySelectorAll('button')
    expect(buttons[0]?.disabled).toBe(true)
  })

  it('disables next button at the end of deck', () => {
    const { container } = renderElement(createElement(PresentationControls, { ...defaultProps, slideIndex: 4, slideCount: 5, subPage: 0, pageCount: 1 }))
    const buttons = container.querySelectorAll('button')
    expect(buttons[1]?.disabled).toBe(true)
  })

  // The grid is drawn over the pill rather than beside it, so the pill's own buttons are the
  // ones a Tab key would otherwise reach from behind an opaque layer.
  it('puts the pill out of reach while the overview grid is up', () => {
    const { container } = renderElement(createElement(PresentationControls, { ...defaultProps, occluded: true }))
    const chrome = container.querySelector('[data-presentation-chrome]')
    expect(chrome?.hasAttribute('inert')).toBe(true)
    expect(chrome?.className).not.toContain('opacity-0')
  })

  it('names the overview toggle by the state it moves the grid to, and drives that state', () => {
    const closed = renderElement(createElement(PresentationControls, defaultProps))
    expect(closed.container.querySelector(`[aria-label="${t('workspace.presentation_show_overview')}"]`)).toBeTruthy()
    expect(closed.container.querySelector(`[aria-label="${t('workspace.presentation_hide_overview')}"]`)).toBeNull()

    const onToggleOverview = vi.fn()
    const open = renderElement(createElement(PresentationControls, { ...defaultProps, overview: true, onToggleOverview }))
    const button = open.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_hide_overview')}"]`)
    expect(button).toBeTruthy()
    button?.click()
    expect(onToggleOverview).toHaveBeenCalledTimes(1)
  })

  it('sets inert and invisible when chromeHidden is true', () => {
    const { container } = renderElement(createElement(PresentationControls, { ...defaultProps, chromeHidden: true }))
    const chrome = container.querySelector('[data-presentation-chrome]')
    expect(chrome?.hasAttribute('inert')).toBe(true)
    expect(chrome?.className).toContain('invisible')
    expect(chrome?.className).toContain('opacity-0')
  })
})

describe('SlideProgress', () => {
  const widthOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slide-progress]')?.style.width

  it('draws the share of the show that has been reached', () => {
    const { container } = renderElement(createElement(SlideProgress, { page: 1, pageTotal: 4 }))
    expect(widthOf(container)).toBe('25%')
  })

  // N-21: read by slide, a one-slide note that paginates into fourteen pages was drawn as `1 / 1` —
  // a talk that had not been turned was already reported as finished.
  it('keeps a paginating slide from reading as the whole deck', () => {
    const first = renderElement(createElement(SlideProgress, { page: 1, pageTotal: 14 }))
    const last = renderElement(createElement(SlideProgress, { page: 14, pageTotal: 14 }))
    expect(widthOf(first.container)).toBe('7%')
    expect(widthOf(last.container)).toBe('100%')
  })

  it('reads a show of one page as the whole deck', () => {
    const { container } = renderElement(createElement(SlideProgress, { page: 1, pageTotal: 1 }))
    expect(widthOf(container)).toBe('100%')
  })

  it('is decoration the reader is not sent through', () => {
    const { container } = renderElement(createElement(SlideProgress, { page: 2, pageTotal: 3 }))
    const track = container.querySelector('[data-slide-progress]')?.closest('[aria-hidden]')
    expect(track?.getAttribute('aria-hidden')).toBe('true')
  })
})

function chromeProps(overrides: Partial<PresentationControlsProps> = {}): PresentationControlsProps {
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

// Where the show is, is one string with two numbers in it: which slide, and which page of that slide.
// The paginated case is the one that used to be printed as a `3 / 14` and a `2/4` in two places at once.
const ON_PAGE_TWO_OF_FOUR = { slideIndex: 2, slideCount: 14, subPage: 1, pageCount: 4 }

describe('PresentationControls — the position is said once', () => {
  it('keeps a single live region for the whole position', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    expect(container.querySelectorAll('[aria-live]').length).toBe(1)
  })

  it('speaks a sentence carrying all four numbers, in the order the sentence reads them', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    const spoken = container.querySelector('[aria-live]')?.textContent?.trim() ?? ''
    expect(spoken.match(/\d+/g)).toEqual(['3', '14', '2', '4'])
  })
})

describe('PresentationControls — the digits a reader sees are not the announcement', () => {
  it('keeps the visible digits out of the accessibility tree', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    expect(container.querySelector('[data-deck-position]')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('prints the sub-page beside the slide number it belongs to', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    const printed = container.querySelector('[data-deck-position]')?.textContent?.trim() ?? ''
    expect(printed.match(/\d+/g)).toEqual(['3', '14', '2', '4'])
  })
})

describe('PresentationControls — where the digits sit', () => {
  it('prints the position before the step buttons that change it', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    const digits = container.querySelector('[data-deck-position]')
    const prev = container.querySelector(`[aria-label="${t('workspace.presentation_prev')}"]`)
    if (!digits || !prev) throw new Error('the position or its step button is missing')
    expect(Boolean(digits.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })
})

describe('PresentationControls — what the announcement is not', () => {
  it('announces words rather than repeating the digits on screen', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps(ON_PAGE_TWO_OF_FOUR)))
    const spoken = container.querySelector('[aria-live]')?.textContent?.trim() ?? ''
    const printed = container.querySelector('[data-deck-position]')?.textContent?.trim() ?? ''
    expect(spoken).not.toBe(printed)
  })
})

// N-12's other half: the control that started the export says so on itself, so the feedback does not
// depend on any floating layer's place in the stack.
describe('PresentationControls — the export answers from its own button', () => {
  it('marks the image export as working while the deck is being written', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ exporting: true })))
    const button = container.querySelector(`[aria-label="${t('workspace.presentation_export_images')}"]`)
    expect(button?.querySelector('[data-export-spinner]')).toBeTruthy()
  })

  it('leaves the control alone when nothing is being written', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps()))
    expect(container.querySelectorAll('[data-export-spinner]').length).toBe(0)
  })
})

describe('PresentationControls — a handout is asked for like the other exports', () => {
  it('offers the handout by its own name and hands the press to the session', () => {
    const onExportHandout = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ onExportHandout })))
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_export_handout')}"]`)
    expect(button, 'the handout is not reachable by name').not.toBeNull()
    expect(button?.type).toBe('button')
    button?.click()
    expect(onExportHandout).toHaveBeenCalledTimes(1)
  })
})

// N-33's fourth export: a file the recipient plays without this app. It is asked for the same way the
// other three are — by name, on the bar and through the phone's door.
describe('PresentationControls — a deck that plays by itself', () => {
  it('offers the standalone file by its own name and hands the press to the session', () => {
    const onExportHtml = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ onExportHtml })))
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_export_html')}"]`)
    expect(button, 'the standalone export is not reachable by name').not.toBeNull()
    button?.click()
    expect(onExportHtml).toHaveBeenCalledTimes(1)
  })

  it('carries the standalone file behind the door too, since the bar has no room for a fourth icon', () => {
    const onExportHtml = vi.fn()
    // The exports are added to the door's rows by the bar itself, so the press lands on the prop the
    // capsule was handed — the same route the handout row takes.
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()), onExportHtml })))
    act(() => { door()?.click() })
    const row = openExportRows().find((item) => item.textContent?.includes(t('workspace.presentation_export_html')))
    if (!row) throw new Error('the export group has no standalone-export row')
    act(() => { row.click() })
    expect(onExportHtml).toHaveBeenCalledTimes(1)
  })
})

describe('DeckExportProgress — the running count', () => {
  it('is a polite announcement that rides above the panel it reports on', () => {
    const { container } = renderElement(createElement(DeckExportProgress, { current: 2, total: 5 }))
    const pill = container.querySelector('[data-export-progress]')
    expect(pill?.getAttribute('role')).toBe('status')
    expect(pill?.getAttribute('aria-live')).toBe('polite')
    expect(pill?.className).toContain('z-[var(--z-toast)]')
  })
})

// N-19: a deleted note does not blank the projector — keeping the last snapshot is the intended
// freeze — but the lamp must not go on claiming that edits still reach the screen. The control says
// what the show is actually doing, and offers no toggle that could change nothing.
describe('PresentationControls — the show outlived its note', () => {
  it('names the freeze and drops the offer to follow', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ following: true, followLost: true })))
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_follow_lost')}"]`)
    expect(button).toBeTruthy()
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_freeze')}"]`)).toBeNull()
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-pressed')).toBe('false')
  })

  it('refuses a press it cannot carry out', () => {
    const onToggleFollowing = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ followLost: true, onToggleFollowing })))
    container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_follow_lost')}"]`)?.click()
    expect(onToggleFollowing).not.toHaveBeenCalled()
  })

  it('offers follow and freeze again while the note is alive', () => {
    const frozen = renderElement(createElement(PresentationControls, chromeProps()))
    expect(frozen.container.querySelector(`[aria-label="${t('workspace.presentation_follow')}"]`)).toBeTruthy()
    expect(frozen.container.querySelectorAll(`[aria-label="${t('workspace.presentation_follow_lost')}"]`).length).toBe(0)

    const following = renderElement(createElement(PresentationControls, chromeProps({ following: true })))
    expect(following.container.querySelector(`[aria-label="${t('workspace.presentation_freeze')}"]`)).toBeTruthy()
    expect(following.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_freeze')}"]`)?.disabled).toBe(false)
  })
})

// N-17: a binding the presenter cannot find is a binding the presenter does not have. Each capsule
// control that a keystroke drives now names it, spelled the way the card and the menu spell it.
const RECT = { width: 24, height: 24, top: 10, left: 10, right: 34, bottom: 34, x: 10, y: 10, toJSON: () => ({}) } as DOMRect

const KEYED_CONTROL: [MessageKey, string][] = [
  ['workspace.presentation_prev', '←'],
  ['workspace.presentation_next', '→'],
  ['workspace.presentation_show_slides', 'S'],
  ['workspace.presentation_show_overview', 'G'],
  ['workspace.presentation_presenter', 'P'],
  ['workspace.presentation_follow', 'L'],
  ['workspace.presentation_fullscreen', 'F'],
  ['workspace.presentation_exit', 'Esc'],
]

// jsdom lays nothing out, so the anchor has to report a size for the hint to mount at all — and the
// capsule's own delay has to elapse before it does.
async function hintKeyOf(container: HTMLElement, label: string): Promise<string | undefined> {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
  const trigger = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (!trigger) throw new Error(`no capsule control named ${label}`)
  trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500))
  })
  return document.querySelector('[role="tooltip"]')?.querySelector('kbd')?.textContent?.trim()
}

describe('PresentationControls — the key a control answers to', () => {
  it.each(KEYED_CONTROL)('names the keystroke on %s', async (key, cap) => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps()))
    expect(await hintKeyOf(container, t(key))).toBe(cap)
  })

  it('offers no key for a control whose key does nothing', async () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ followLost: true })))
    expect(await hintKeyOf(container, t('workspace.presentation_follow_lost'))).toBeUndefined()
  })

  it('offers no key for an export, because no key drives one', async () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps()))
    expect(await hintKeyOf(container, t('workspace.presentation_export'))).toBeUndefined()
  })
})

// N-18 + N-35: measured at 390×844 the bar is 453px wide, so it hangs off both edges and its × control
// lands at x=385..417 — outside the screen, with nothing to scroll it into view. A thumb that cannot
// reach the way out cannot reach the four tools either, because they only live on letters and on a
// right-click this surface never gets. So the narrow bar keeps three things and the rest goes through
// one door: the same rows the right-click menu already builds.
// Rows are `menuitem` or `menuitemcheckbox` depending on whether the row carries a mark, so the door is
// read by what it holds rather than by which of the two roles a row happens to claim.
const door = () => document.querySelector<HTMLElement>('[data-presentation-overflow]')
// The exports and the four screen modes live behind one door row each now (PR-M1), so a test that
// wants one of them opens the group first and reads the nested panel — `[role="group"]` named after
// the row that opened it.
function openDoorGroup(label: string): HTMLElement[] {
  const group = [...document.querySelectorAll<HTMLElement>('[role="menu"] [aria-haspopup="menu"]')].find((row) => row.textContent?.includes(label))
  if (!group) throw new Error(`the door has no ${label} row`)
  act(() => { group.click() })
  return [...document.querySelectorAll<HTMLElement>(`[role="group"][aria-label="${label}"] [role="menuitem"], [role="group"][aria-label="${label}"] [role="menuitemcheckbox"]`)]
}
const openExportRows = () => openDoorGroup(t('workspace.export'))
const openModeRows = () => openDoorGroup(t('workspace.presentation_modes'))

describe('PresentationControls at phone width', () => {
  it('keeps the turn and the way out, and folds the rest behind one door', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_prev')}"]`)).toBeTruthy()
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_exit')}"]`)).toBeTruthy()
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_show_overview')}"]`)).toBeNull()
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_export')}"]`)).toBeNull()
    expect(container.querySelectorAll('[data-presentation-overflow]').length).toBe(1)
  })

  it('draws no door on a wide screen, where every control already fits', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps()))
    expect(container.querySelector('[data-presentation-overflow]')).toBeNull()
    expect(container.querySelector(`[aria-label="${t('workspace.presentation_show_overview')}"]`)).toBeTruthy()
  })

  it('hands a thumb the four tools no key on this screen can reach', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    act(() => {
      door()?.click()
    })
    const modes = openModeRows()
    for (const label of [t('workspace.presentation_laser'), t('workspace.presentation_spotlight'), t('workspace.presentation_blackout'), t('workspace.presentation_whiteout')]) {
      expect(modes.some((row) => row.textContent?.includes(label)), label).toBe(true)
    }
    expect(modes).toHaveLength(4)
  })

  it('keeps the door short enough that everything on it can be reached', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    act(() => {
      door()?.click()
    })
    const top = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]')]
    expect(top.length).toBeLessThanOrEqual(9)
    for (const label of [t('workspace.presentation_modes'), t('workspace.export')]) {
      expect(top.some((row) => row.textContent?.includes(label)), label).toBe(true)
    }
  })

  it('says on the group row that one of the modes it holds is on', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems({ ...menuOptions(), laser: true }) })))
    act(() => {
      door()?.click()
    })
    const group = [...document.querySelectorAll<HTMLElement>('[role="menu"] [aria-haspopup="menu"]')].find((row) => row.textContent?.includes(t('workspace.presentation_modes')))
    expect(group?.getAttribute('aria-checked'), 'a door that hides an active mode reads as nothing is on').toBe('true')
  })

})

describe('PresentationControls — what the door hands over', () => {
  it('runs the row a press names, and closes the door on it', () => {
    const onToggleLaser = vi.fn()
    const items = buildPresentationOverflowItems({ ...menuOptions(), onToggleLaser })
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: items })))
    act(() => {
      door()?.click()
    })
    const row = openModeRows().find((item) => item.textContent?.includes(t('workspace.presentation_laser')))
    if (!row) throw new Error('the modes group has no laser row to press')
    act(() => {
      row.click()
    })
    expect(onToggleLaser).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('carries the exports through the door too, since they no longer fit beside it', () => {
    const onExportHandout = vi.fn()
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()), onExportHandout })))
    act(() => {
      door()?.click()
    })
    const row = openExportRows().find((item) => item.textContent?.includes(t('workspace.presentation_export_handout')))
    if (!row) throw new Error('the export group has no handout row')
    act(() => {
      row.click()
    })
    expect(onExportHandout).toHaveBeenCalledTimes(1)
  })

  it('folds the four exports into one row, so the door fits the phone it is on', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    act(() => {
      door()?.click()
    })
    const top = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]')]
    expect(top.some((row) => row.textContent?.includes(t('workspace.export'))), 'the door lists the exports one row at a time').toBe(true)
    for (const label of [t('workspace.presentation_export'), t('workspace.presentation_export_handout'), t('workspace.presentation_export_html'), t('workspace.presentation_export_images')]) {
      expect(top.some((row) => row.textContent?.includes(label)), `the door still shows ${label} on its own`).toBe(false)
    }
    expect(openExportRows()).toHaveLength(4)
  })

})

describe('PresentationControls — the door and the exports', () => {
  it('runs the export row a press names, not just the one it was written for', () => {
    const onExportImages = vi.fn()
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()), onExportImages })))
    act(() => {
      door()?.click()
    })
    const row = openExportRows().find((item) => item.textContent?.includes(t('workspace.presentation_export_images')))
    if (!row) throw new Error('the export group has no image-export row')
    act(() => {
      row.click()
    })
    expect(onExportImages).toHaveBeenCalledTimes(1)
  })

  it('lets an export that is still running say so on the row the presenter can see', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, exporting: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    act(() => {
      door()?.click()
    })
    const group = [...document.querySelectorAll<HTMLElement>('[role="menu"] [aria-haspopup="menu"]')].find((row) => row.textContent?.includes(t('workspace.export')))
    expect(group?.querySelector('[data-export-spinner]'), 'the working export is hidden behind a row with no mark').toBeTruthy()
  })

  it('paints the door inside the projector it belongs to, not beside it', () => {
    renderElement(createElement('div', { role: 'dialog' }, createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) }))))
    act(() => {
      door()?.click()
    })
    const projector = document.querySelector('[role="dialog"]')
    expect(projector?.querySelector('[role="menu"]')).toBeTruthy()
  })

  it('leaves the tab order out of the door while it is shut', () => {
    renderElement(createElement(PresentationControls, chromeProps({ compact: true, overflowItems: buildPresentationOverflowItems(menuOptions()) })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

// PR-H1: a faded bar is `inert` *and* `invisible`, and the browser's hit test walks past both to the
// stage behind — so the first tap a presenter makes where the controls are turns the page instead of
// bringing them back. jsdom does no hit testing, so what is pinned here is the shape the fix needs to
// have: a target that is not faded, sized to the bar's own rectangle, standing between the two.
describe('PresentationControls — the first tap on a faded bar', () => {
  it('stands a hit target where the faded bar is', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: true })))
    const guard = container.querySelector('[data-presentation-chrome-guard]')
    const bar = container.querySelector('[data-presentation-chrome]')
    expect(guard, 'nothing covers the bar’s rectangle while it is faded').toBeTruthy()
    expect(bar?.hasAttribute('inert'), 'the bar itself stays out of the tab order').toBe(true)
    expect(guard?.hasAttribute('inert')).toBe(false)
    expect(guard?.contains(bar ?? null)).toBe(true)
  })

  it('takes none of the fade itself', () => {
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: true })))
    const guard = container.querySelector('[data-presentation-chrome-guard]')
    const bar = container.querySelector('[data-presentation-chrome]')
    expect(guard?.className).not.toMatch(/invisible|opacity-0|pointer-events-none/)
    expect(bar?.className).toMatch(/invisible/)
  })

  it('still hands a press to the control once the bar is up', () => {
    const onNext = vi.fn()
    const { container } = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: false, onNext })))
    const bar = container.querySelector('[data-presentation-chrome]')
    expect(bar?.hasAttribute('inert')).toBe(false)
    container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)?.click()
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('spends the waking gesture on waking, not on the control that appeared under it', () => {
    const onNext = vi.fn()
    const view = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: true, onNext })))
    const guard = view.container.querySelector<HTMLElement>('[data-presentation-chrome-guard]')
    if (!guard) throw new Error('no guard to press')
    act(() => { guard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    view.rerender(createElement(PresentationControls, chromeProps({ chromeHidden: false, onNext })))
    act(() => {
      view.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)?.click()
    })
    expect(onNext, 'the tap that only brought the bar back pressed a button too').not.toHaveBeenCalled()
    view.unmount()
  })

  it('pays the debt once: the press right behind the waking one is not also swallowed', () => {
    const onNext = vi.fn()
    const view = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: true, onNext })))
    const guard = view.container.querySelector<HTMLElement>('[data-presentation-chrome-guard]')
    if (!guard) throw new Error('no guard to press')
    act(() => { guard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    view.rerender(createElement(PresentationControls, chromeProps({ chromeHidden: false, onNext })))
    const next = () => view.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)
    act(() => { next()?.click() })
    expect(onNext, 'the waking gesture pressed the button').not.toHaveBeenCalled()
    act(() => { next()?.click() })
    expect(onNext, 'a thumb that taps again at once is not still being refused').toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('forgets that debt for the next press, which is a real one', () => {
    vi.useFakeTimers()
    try {
      const onNext = vi.fn()
      const view = renderElement(createElement(PresentationControls, chromeProps({ chromeHidden: true, onNext })))
      const guard = view.container.querySelector<HTMLElement>('[data-presentation-chrome-guard]')
      if (!guard) throw new Error('no guard to press')
      act(() => { guard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
      view.rerender(createElement(PresentationControls, chromeProps({ chromeHidden: false, onNext })))
      act(() => {
        view.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)?.click()
      })
      expect(onNext).not.toHaveBeenCalled()
      vi.advanceTimersByTime(900)
      act(() => {
        view.container.querySelector<HTMLButtonElement>(`[aria-label="${t('workspace.presentation_next')}"]`)?.click()
      })
      expect(onNext).toHaveBeenCalledTimes(1)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('PresentationExitConfirm — the question a show with an audience asks', () => {
  const press = (el: HTMLElement | null | undefined) => {
    if (!el) throw new Error('the confirm is missing a button')
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }
  const answer = (dialog: Element | null | undefined, label: string) =>
    [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === label)

  it('is not in the tree until the show is asked to leave', () => {
    const view = renderElement(createElement(PresentationExitConfirm, { open: false, onConfirm: vi.fn(), onCancel: vi.fn() }))
    expect(view.container.querySelector('[data-presentation-exit-confirm]')).toBeNull()
    view.unmount()
  })

  it('names the question and offers both answers', () => {
    const view = renderElement(createElement(PresentationExitConfirm, { open: true, onConfirm: vi.fn(), onCancel: vi.fn() }))
    const dialog = view.container.querySelector<HTMLElement>('[data-presentation-exit-confirm]')
    expect(dialog?.getAttribute('role')).toBe('alertdialog')
    expect(dialog?.getAttribute('aria-label')).toBe(t('workspace.presentation_exit_audience'))
    const buttons = [...(dialog?.querySelectorAll('button') ?? [])]
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([t('common.cancel'), t('workspace.presentation_exit')])
    expect(dialog?.contains(document.activeElement)).toBe(true)
    view.unmount()
  })

  // The safe answer takes the focus, so the key that opens the question cannot end the talk on the way
  // through — the same rule the app's own confirm layer follows for anything destructive.
  it('puts the focus on the answer that keeps the show', () => {
    const view = renderElement(createElement(PresentationExitConfirm, { open: true, onConfirm: vi.fn(), onCancel: vi.fn() }))
    expect(document.activeElement?.textContent?.trim()).toBe(t('common.cancel'))
    view.unmount()
  })

  it('ends the show only on the answer that says so', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const view = renderElement(createElement(PresentationExitConfirm, { open: true, onConfirm, onCancel }))
    press(answer(view.container.querySelector('[data-presentation-exit-confirm]'), t('workspace.presentation_exit')))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps the show on the answer that says stay', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const view = renderElement(createElement(PresentationExitConfirm, { open: true, onConfirm, onCancel }))
    press(answer(view.container.querySelector('[data-presentation-exit-confirm]'), t('common.cancel')))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    view.unmount()
  })
})
