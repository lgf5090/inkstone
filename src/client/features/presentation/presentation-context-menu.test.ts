import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { menuOptions } from './presentation-menu-options.test-helpers'
import {
  buildPresentationMenuItems,
  extractAnchorHrefFromPoint,
  extractLinkHref,
  PresentationContextMenu,
  type PresentationContextMenuProps,
  type PresentationMenuItemsOptions,
} from './presentation-context-menu'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('buildPresentationMenuItems — item composition', () => {
  it('builds standard presentation menu items when there is no link', () => {
    const opts = menuOptions()
    const items = buildPresentationMenuItems(opts)
    const ids = items.map((i) => i.id)
    expect(ids).toEqual([
      'prev',
      'next',
      'overview',
      'rail',
      'presenter',
      'laser',
      'spotlight',
      'blackout',
      'whiteout',
      'follow',
      'fullscreen',
      'key-guide',
      'exit',
    ])
    expect(items.find((i) => i.id === 'prev')?.separatorBefore).toBe(false)
  })

  it('prepends link open and copy items when linkUrl is present', () => {
    const opts = { ...menuOptions(), linkUrl: 'https://example.com/demo' }
    const items = buildPresentationMenuItems(opts)
    const ids = items.map((i) => i.id)
    expect(ids[0]).toBe('link-open')
    expect(ids[1]).toBe('link-copy')
    expect(items.find((i) => i.id === 'prev')?.separatorBefore).toBe(true)
  })
})

describe('buildPresentationMenuItems — link actions', () => {
  it('triggers window.open on selecting link-open', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const opts = { ...menuOptions(), linkUrl: 'https://example.com/demo' }
    const items = buildPresentationMenuItems(opts)
    const linkOpen = items.find((i) => i.id === 'link-open')
    linkOpen?.onSelect?.()
    expect(openSpy).toHaveBeenCalledWith('https://example.com/demo', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })

  it('triggers clipboard writeText on selecting link-copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const opts = { ...menuOptions(), linkUrl: 'https://example.com/copy-me' }
    const items = buildPresentationMenuItems(opts)
    const linkCopy = items.find((i) => i.id === 'link-copy')
    linkCopy?.onSelect?.()
    expect(writeText).toHaveBeenCalledWith('https://example.com/copy-me')
  })

  it('extracts link href safely from DOM anchor, SVG anchor, or returns null', () => {
    expect(extractLinkHref(null)).toBeNull()

    const standardAnchor = document.createElement('a')
    standardAnchor.setAttribute('href', 'https://inkstone.app/docs')
    expect(extractLinkHref(standardAnchor)).toBe('https://inkstone.app/docs')

    const svgAnchor = {
      getAttribute: (attr: string) => (attr === 'href' ? 'https://svg.example.com' : null),
      href: { baseVal: 'https://svg.example.com', animVal: 'https://svg.example.com' },
    } as unknown as HTMLAnchorElement
    expect(extractLinkHref(svgAnchor)).toBe('https://svg.example.com')
  })
})

describe('buildPresentationMenuItems — link protocol whitelist', () => {
  // The left click on the projector and these two menu items are the same action on the same href, so
  // they consult one whitelist: an href the slide refuses may not get an offer the slide would not act on.
  const refused: Array<[label: string, href: string]> = [
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
    ['data:', 'data:text/html,<p>hi</p>'],
    ['relative note link', '/notes/another'],
    ['in-page anchor', '#slide-heading'],
  ]

  it.each(refused)('offers no link item for a %s href', (_label, href) => {
    const items = buildPresentationMenuItems({ ...menuOptions(), linkUrl: href })
    const ids = items.map((item) => item.id)
    expect(ids).not.toContain('link-open')
    expect(ids).not.toContain('link-copy')
    expect(ids[0]).toBe('prev')
    expect(items.find((item) => item.id === 'prev')?.separatorBefore).toBe(false)
  })

  it.each([
    ['HTTPS://Example.COM/Talk#Section', 'a scheme written in capitals'],
    ['mailto:speaker@example.com', 'a mailto:'],
  ])('offers the link items for %s — %s', (href) => {
    const items = buildPresentationMenuItems({ ...menuOptions(), linkUrl: href })
    expect(items.map((item) => item.id).slice(0, 2)).toEqual(['link-open', 'link-copy'])
    expect(items.find((item) => item.id === 'prev')?.separatorBefore).toBe(true)
  })
})

// The hit stack comes back in paint order, so the first element under the pointer is what the show is
// drawing. Searching past it reaches a link hidden under an opaque surface, and reaching outside the panel
// reaches the application behind the projector — either way the menu would offer a link nobody aimed at.
function withStack(elements: Element[], run: () => void) {
  const original = document.elementsFromPoint
  document.elementsFromPoint = vi.fn().mockReturnValue(elements)
  try {
    run()
  }
  finally {
    document.elementsFromPoint = original
  }
}

function element(tag: 'a' | 'div' | 'p', href?: string) {
  const node = document.createElement(tag)
  if (href) node.setAttribute('href', href)
  return node
}

describe('extractAnchorHrefFromPoint — what the projector shows', () => {
  it('resolves the link the projector is showing', () => {
    const panel = element('div')
    const anchor = element('a', 'https://example.com/on-stage')
    panel.append(anchor)
    document.body.append(panel)
    withStack([anchor, panel], () => {
      expect(extractAnchorHrefFromPoint(10, 10, null, panel)).toBe('https://example.com/on-stage')
    })
    panel.remove()
  })

  it('looks past the open menu itself when the second right click lands on one of its rows', () => {
    const panel = element('div')
    const anchor = element('a', 'https://example.com/re-aimed')
    const menu = element('div')
    menu.setAttribute('role', 'menu')
    const row = element('div')
    menu.append(row)
    panel.append(anchor, menu)
    document.body.append(panel)
    const backdrop = element('div')
    backdrop.setAttribute('data-presentation-menu-backdrop', '')
    withStack([row, backdrop, anchor], () => {
      expect(extractAnchorHrefFromPoint(10, 10, row, panel)).toBe('https://example.com/re-aimed')
    })
    panel.remove()
  })
})

describe('extractAnchorHrefFromPoint — what the projector hides', () => {
  it('ignores a link that sits under an opaque surface of its own', () => {
    const panel = element('div')
    const cover = element('div')
    const hidden = element('a', 'https://example.com/under-the-cover')
    panel.append(cover, hidden)
    document.body.append(panel)
    withStack([cover, hidden], () => {
      expect(extractAnchorHrefFromPoint(10, 10, null, panel)).toBeNull()
    })
    panel.remove()
  })

  it('ignores a link outside the projector panel', () => {
    const panel = element('div')
    const stage = element('p')
    panel.append(stage)
    document.body.append(panel)
    const outside = element('a', 'https://example.com/behind-the-show')
    document.body.append(outside)
    withStack([stage, panel, outside], () => {
      expect(extractAnchorHrefFromPoint(10, 10, null, panel)).toBeNull()
    })
    panel.remove()
    outside.remove()
  })

  it('resolves nothing when the menu has no panel to constrain it to', () => {
    const anchor = element('a', 'https://example.com/orphan')
    document.body.append(anchor)
    withStack([anchor], () => {
      expect(extractAnchorHrefFromPoint(10, 10, null, null)).toBeNull()
    })
    anchor.remove()
  })
})

describe('buildPresentationMenuItems — pagination bounds', () => {
  it('disables prev item when on the first slide and subpage', () => {
    const opts = { ...menuOptions(), slideIndex: 0, subPage: 0 }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'prev')?.disabled).toBe(true)
    expect(items.find((i) => i.id === 'next')?.disabled).toBe(false)
  })

  it('disables next item when on the final slide and subpage', () => {
    const opts = { ...menuOptions(), slideIndex: 4, slideCount: 5, subPage: 1, pageCount: 2 }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'prev')?.disabled).toBe(false)
    expect(items.find((i) => i.id === 'next')?.disabled).toBe(true)
  })

  it('enables both prev and next when in the middle of a deck', () => {
    const opts = { ...menuOptions(), slideIndex: 2, slideCount: 5, subPage: 0, pageCount: 1 }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'prev')?.disabled).toBe(false)
    expect(items.find((i) => i.id === 'next')?.disabled).toBe(false)
  })

  // N-31: a page that is still arriving is never the start of the show, however early in the deck it is.
  it('keeps both rows alive on the first slide while its page is arriving', () => {
    const opts = { ...menuOptions(), slideIndex: 0, slideCount: 3, subPage: 0, pageCount: 1, step: 1, steps: 2 }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'prev')?.disabled).toBe(false)
    expect(items.find((i) => i.id === 'next')?.disabled).toBe(false)
  })

  it('disables next once the last reveal of the last page of the last slide is on screen', () => {
    const opts = { ...menuOptions(), slideIndex: 2, slideCount: 3, subPage: 0, pageCount: 1, step: 2, steps: 2 }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'prev')?.disabled).toBe(false)
    expect(items.find((i) => i.id === 'next')?.disabled).toBe(true)
  })
})

describe('buildPresentationMenuItems — checked states', () => {
  it('reflects active checked state for toggles and covers', () => {
    const opts = {
      ...menuOptions(),
      railOpen: true,
      overview: true,
      following: true,
      isFullscreen: true,
      laser: true,
      spotlight: true,
      screenCover: 'black' as const,
    }
    const items = buildPresentationMenuItems(opts)
    expect(items.find((i) => i.id === 'rail')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'overview')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'follow')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'fullscreen')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'laser')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'spotlight')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'blackout')?.checked).toBe(true)
    expect(items.find((i) => i.id === 'whiteout')?.checked).toBe(false)
  })
})

describe('buildPresentationMenuItems — item selection callbacks', () => {
  it('invokes corresponding action callbacks when items are selected', () => {
    const opts = menuOptions()
    const items = buildPresentationMenuItems(opts)
    items.find((i) => i.id === 'prev')?.onSelect?.()
    items.find((i) => i.id === 'next')?.onSelect?.()
    items.find((i) => i.id === 'overview')?.onSelect?.()
    items.find((i) => i.id === 'rail')?.onSelect?.()
    items.find((i) => i.id === 'presenter')?.onSelect?.()
    items.find((i) => i.id === 'laser')?.onSelect?.()
    items.find((i) => i.id === 'spotlight')?.onSelect?.()
    items.find((i) => i.id === 'blackout')?.onSelect?.()
    items.find((i) => i.id === 'whiteout')?.onSelect?.()
    items.find((i) => i.id === 'follow')?.onSelect?.()
    items.find((i) => i.id === 'fullscreen')?.onSelect?.()
    items.find((i) => i.id === 'exit')?.onSelect?.()

    expect(opts.onPrev).toHaveBeenCalledTimes(1)
    expect(opts.onNext).toHaveBeenCalledTimes(1)
    expect(opts.onToggleOverview).toHaveBeenCalledTimes(1)
    expect(opts.onToggleRail).toHaveBeenCalledTimes(1)
    expect(opts.onOpenPresenter).toHaveBeenCalledTimes(1)
    expect(opts.onToggleLaser).toHaveBeenCalledTimes(1)
    expect(opts.onToggleSpotlight).toHaveBeenCalledTimes(1)
    expect(opts.onToggleBlackout).toHaveBeenCalledTimes(1)
    expect(opts.onToggleWhiteout).toHaveBeenCalledTimes(1)
    expect(opts.onToggleFollowing).toHaveBeenCalledTimes(1)
    expect(opts.onToggleFullscreen).toHaveBeenCalledTimes(1)
    expect(opts.onExit).toHaveBeenCalledTimes(1)
  })
})

describe('PresentationContextMenu — component rendering', () => {
  it('renders nothing when point is null', () => {
    const props: PresentationContextMenuProps = {
      ...menuOptions(),
      point: null,
      onClose: vi.fn(),
      onReopen: vi.fn(),
    }
    const view = renderElement(createElement(PresentationContextMenu, props))
    expect(document.querySelector('[data-presentation-menu-backdrop]')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    view.unmount()
  })

  it('renders backdrop and menu into custom container when point is provided', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const props: PresentationContextMenuProps = {
      ...menuOptions(),
      point: { x: 150, y: 220 },
      container,
      onClose: vi.fn(),
      onReopen: vi.fn(),
    }
    const view = renderElement(createElement(PresentationContextMenu, props))
    const backdrop = container.querySelector('[data-presentation-menu-backdrop]')
    const menu = container.querySelector('[role="menu"]')
    expect(backdrop).toBeTruthy()
    expect(menu).toBeTruthy()
    expect(backdrop?.className).toContain('cursor-default')
    view.unmount()
  })
})

describe('PresentationContextMenu — backdrop interaction', () => {
  it('intercepts click on backdrop and closes without penetrating to underlying elements', () => {
    const onClose = vi.fn()
    const props: PresentationContextMenuProps = {
      ...menuOptions(),
      point: { x: 100, y: 100 },
      onClose,
      onReopen: vi.fn(),
    }
    const view = renderElement(createElement(PresentationContextMenu, props))
    const backdrop = document.querySelector('[data-presentation-menu-backdrop]')
    expect(backdrop).toBeTruthy()

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
    backdrop?.dispatchEvent(clickEvent)
    expect(clickEvent.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('reopens menu at new coordinate when right clicking on backdrop', () => {
    const onReopen = vi.fn()
    const props: PresentationContextMenuProps = {
      ...menuOptions(),
      point: { x: 100, y: 100 },
      onClose: vi.fn(),
      onReopen,
    }
    const view = renderElement(createElement(PresentationContextMenu, props))
    const backdrop = document.querySelector('[data-presentation-menu-backdrop]')
    expect(backdrop).toBeTruthy()

    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 250,
      clientY: 320,
    })
    backdrop?.dispatchEvent(contextEvent)
    expect(contextEvent.defaultPrevented).toBe(true)
    expect(onReopen).toHaveBeenCalledWith({ x: 250, y: 320 }, null)
    view.unmount()
  })
})

// The show's own panel is what the menu is allowed to read a link out of: the backdrop covers the whole
// viewport, and everything the projector hides — the note list, the sidebar — is still in the document
// under it.
function renderOverPanel() {
  const onReopen = vi.fn()
  const panel = document.createElement('div')
  document.body.append(panel)
  const view = renderElement(createElement(PresentationContextMenu, {
    ...menuOptions(),
    point: { x: 100, y: 100 },
    onClose: vi.fn(),
    onReopen,
    container: panel,
  }))
  const backdrop = panel.querySelector('[data-presentation-menu-backdrop]')
  expect(backdrop).toBeTruthy()
  return { panel, view, backdrop, onReopen }
}

function rightClick(backdrop: Element | null, x: number, y: number) {
  const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  backdrop?.dispatchEvent(contextEvent)
  expect(contextEvent.defaultPrevented).toBe(true)
}

describe('PresentationContextMenu — backdrop link and stacking', () => {
  it('reopens menu with extracted link when right clicking over an underlying anchor via elementsFromPoint', () => {
    const { panel, view, backdrop, onReopen } = renderOverPanel()

    const anchor = document.createElement('a')
    anchor.setAttribute('href', 'https://example.com/slide-link')
    panel.append(anchor)

    const originalElementsFromPoint = document.elementsFromPoint
    document.elementsFromPoint = vi.fn().mockReturnValue([backdrop, anchor])

    rightClick(backdrop, 300, 400)
    expect(onReopen).toHaveBeenCalledWith({ x: 300, y: 400 }, 'https://example.com/slide-link')

    document.elementsFromPoint = originalElementsFromPoint
    view.unmount()
    panel.remove()
  })

  it('sets backdrop z-index to Z_INDEX.menu to ensure it stacks above slide overlays and overview grid', () => {
    const props: PresentationContextMenuProps = {
      ...menuOptions(),
      point: { x: 50, y: 50 },
      onClose: vi.fn(),
      onReopen: vi.fn(),
    }
    const view = renderElement(createElement(PresentationContextMenu, props))
    const backdrop = document.querySelector<HTMLElement>('[data-presentation-menu-backdrop]')
    expect(backdrop?.style.zIndex).toBe('260')
    view.unmount()
  })
})

describe('PresentationContextMenu — a link behind the projector is not a link on it', () => {
  it('reopens with no link when the point lands on the slide and an anchor lives behind the projector', () => {
    const { panel, view, backdrop, onReopen } = renderOverPanel()

    const stage = document.createElement('p')
    panel.append(stage)
    const outside = document.createElement('a')
    outside.setAttribute('href', 'https://example.com/behind-the-show')
    document.body.append(outside)

    const originalElementsFromPoint = document.elementsFromPoint
    document.elementsFromPoint = vi.fn().mockReturnValue([backdrop, stage, panel, outside])

    rightClick(backdrop, 300, 400)
    expect(onReopen).toHaveBeenCalledWith({ x: 300, y: 400 }, null)

    document.elementsFromPoint = originalElementsFromPoint
    view.unmount()
    panel.remove()
    outside.remove()
  })
})

// N-19's other hand: the menu drives the same toggle as the capsule, so a row that offers to follow a
// note that no longer exists would be the one place the show still claims to be live.
describe('buildPresentationMenuItems — a follow that cannot follow', () => {
  const followRow = (options: PresentationMenuItemsOptions) => buildPresentationMenuItems(options).find((item) => item.id === 'follow')

  it('disables the row and names the freeze once the note is gone', () => {
    const row = followRow({ ...menuOptions(), following: true, followLost: true })
    expect(row?.label).toBe(t('workspace.presentation_follow_lost'))
    expect(row?.disabled).toBe(true)
    expect(row?.checked).toBe(false)
  })

  it('keeps the row live while the note is still there', () => {
    const alive = followRow({ ...menuOptions(), following: true })
    expect(alive?.label).toBe(t('workspace.presentation_follow'))
    expect(alive?.disabled).toBeFalsy()
    expect(alive?.checked).toBe(true)
  })
})
