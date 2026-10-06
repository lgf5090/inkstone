/**
 * The keys read from the side that owns the state: what a keystroke does to the pointer mode,
 * which keystroke the show hands over to a focused control, and what happens to a mode nobody
 * exited when the show itself closes.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { usePresentationKeys, type PresentationKeysOptions } from './use-presentation-keys'

function Host({ props }: { props: PresentationKeysOptions }) {
  const { laser, spotlight, overview, screenCover, keyGuide } = usePresentationKeys(props)
  return createElement('span', {
    'data-laser': String(laser),
    'data-spotlight': String(spotlight),
    'data-overview': String(overview),
    'data-cover': screenCover ?? 'none',
    'data-key-guide': String(keyGuide),
  })
}

function state(container: HTMLElement) {
  const marker = container.querySelector('span')
  return {
    laser: marker?.getAttribute('data-laser'),
    spotlight: marker?.getAttribute('data-spotlight'),
    overview: marker?.getAttribute('data-overview'),
    cover: marker?.getAttribute('data-cover'),
    keyGuide: marker?.getAttribute('data-key-guide'),
  }
}

// The key arrives the way a browser sends it: nothing focused, so the event lands on the body and
// bubbles up to the show's capture listener on `window`. `act` because the state a keystroke
// changes belongs to React, and reading the DOM before it has committed proves nothing.
function press(key: string, target: EventTarget = document.body): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

const options = (): PresentationKeysOptions => ({
  open: true,
  slideCount: 3,
  goNext: vi.fn(),
  goPrev: vi.fn(),
  jumpTo: vi.fn(),
  toggleFullscreen: vi.fn(),
  toggleRail: vi.fn(),
  toggleFollowing: vi.fn(),
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('usePresentationKeys — the laser pointer', () => {
  it('turns the pointer on and back off with C', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('c')
    expect(state(view.container).laser).toBe('true')
    press('C')
    expect(state(view.container).laser).toBe('false')
    view.unmount()
  })

  it('hands C to a focused control instead of hijacking the keystroke', () => {
    const button = document.createElement('button')
    document.body.append(button)
    const view = renderElement(createElement(Host, { props: options() }))
    press('c', button)
    expect(state(view.container).laser).toBe('false')
    view.unmount()
  })

  it('goes out with the show, so a closed talk leaves no dot on the page', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('c')
    view.rerender(createElement(Host, { props: { ...options(), open: false } }))
    expect(state(view.container).laser).toBe('false')
    view.unmount()
  })

  it('lets a screen cover take the key, which is what brings the slide back', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('b')
    expect(state(view.container).cover).toBe('black')
    press('c')
    expect(state(view.container).cover).toBe('none')
    expect(state(view.container).laser).toBe('false')
    view.unmount()
  })
})

describe('usePresentationKeys — the slide overview', () => {
  it('opens the grid on O and puts it away on the same key', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('o')
    expect(state(view.container).overview).toBe('true')
    press('O')
    expect(state(view.container).overview).toBe('false')
    view.unmount()
  })

  it('opens the same grid on G, which is what the matrix reads as', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('g')
    expect(state(view.container).overview).toBe('true')
    press('o')
    expect(state(view.container).overview).toBe('false')
    view.unmount()
  })

  it('hands O to a focused control instead of hijacking the keystroke', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const view = renderElement(createElement(Host, { props: options() }))
    press('o', input)
    expect(state(view.container).overview).toBe('false')
    view.unmount()
  })

  it('goes out with the show, so a closed talk leaves no grid on the page', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('o')
    view.rerender(createElement(Host, { props: { ...options(), open: false } }))
    expect(state(view.container).overview).toBe('false')
    view.unmount()
  })

  it('leaves the arrows to the grid the presenter is roaming', () => {
    const props = options()
    const grid = document.createElement('div')
    grid.setAttribute('data-presentation-overview', '')
    const card = document.createElement('button')
    grid.append(card)
    document.body.append(grid)
    const view = renderElement(createElement(Host, { props }))
    press('ArrowRight', card)
    expect(props.goNext).not.toHaveBeenCalled()
    expect(props.goPrev).not.toHaveBeenCalled()
    view.unmount()
  })

  // N-15: one Tab from the opened show lands the presenter in the slide list, and the list walks its
  // column with the vertical keys only — so the sideways turn belongs to the show even while the
  // list holds the focus ring.
  it('turns the page sideways while the slide list holds the focus', () => {
    const props = options()
    const rail = document.createElement('div')
    rail.setAttribute('data-presentation-rail', '')
    const tab = document.createElement('button')
    rail.append(tab)
    document.body.append(rail)
    const view = renderElement(createElement(Host, { props }))

    press('ArrowRight', tab)
    expect(props.goNext).toHaveBeenCalledTimes(1)
    press('ArrowLeft', tab)
    expect(props.goPrev).toHaveBeenCalledTimes(1)

    press('ArrowDown', tab)
    expect(props.goNext).toHaveBeenCalledTimes(1)
    expect(props.goPrev).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('lets a screen cover take the key while the grid is up', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('o')
    press('b')
    expect(state(view.container).cover).toBe('black')
    expect(state(view.container).overview).toBe('true')
    view.unmount()
  })

  it('does not throw when key event targets document or window', () => {
    const props = options()
    const view = renderElement(createElement(Host, { props }))
    expect(() => press('ArrowRight', document)).not.toThrow()
    expect(props.goNext).toHaveBeenCalledTimes(1)
    expect(() => press('c', window)).not.toThrow()
    expect(state(view.container).laser).toBe('true')
    view.unmount()
  })
})

describe('usePresentationKeys — the spotlight tool', () => {
  it('turns spotlight on and off with T and K', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('t')
    expect(state(view.container).spotlight).toBe('true')
    press('T')
    expect(state(view.container).spotlight).toBe('false')
    press('k')
    expect(state(view.container).spotlight).toBe('true')
    press('K')
    expect(state(view.container).spotlight).toBe('false')
    view.unmount()
  })

  it('enforces mutual exclusion between laser and spotlight', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('c')
    expect(state(view.container).laser).toBe('true')
    expect(state(view.container).spotlight).toBe('false')
    press('t')
    expect(state(view.container).laser).toBe('false')
    expect(state(view.container).spotlight).toBe('true')
    press('c')
    expect(state(view.container).laser).toBe('true')
    expect(state(view.container).spotlight).toBe('false')
    view.unmount()
  })

  it('hands T and K to a focused control instead of hijacking the keystroke', () => {
    const button = document.createElement('button')
    document.body.append(button)
    const view = renderElement(createElement(Host, { props: options() }))
    press('t', button)
    expect(state(view.container).spotlight).toBe('false')
    press('k', button)
    expect(state(view.container).spotlight).toBe('false')
    view.unmount()
  })

  it('goes out with the show', () => {
    const props = options()
    const view = renderElement(createElement(Host, { props }))
    press('t')
    expect(state(view.container).spotlight).toBe('true')
    view.rerender(createElement(Host, { props: { ...props, open: false } }))
    expect(state(view.container).spotlight).toBe('false')
    view.unmount()
  })
})

describe('usePresentationKeys — menu context isolation', () => {
  it('blocks ArrowDown and ArrowUp navigation when isMenuOpen is true', () => {
    const props = { ...options(), isMenuOpen: true }
    const view = renderElement(createElement(Host, { props }))
    press('ArrowDown')
    press('ArrowUp')
    expect(props.goNext).not.toHaveBeenCalled()
    expect(props.goPrev).not.toHaveBeenCalled()
    view.unmount()
  })

  it('blocks navigation when focus is inside a menu element', () => {
    const props = options()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    menu.append(item)
    document.body.append(menu)
    const view = renderElement(createElement(Host, { props }))
    press('ArrowDown', item)
    press('ArrowUp', item)
    expect(props.goNext).not.toHaveBeenCalled()
    expect(props.goPrev).not.toHaveBeenCalled()
    view.unmount()
  })
})

describe('usePresentationKeys — toggle helpers', () => {
  it('exposes direct toggle helpers for laser, blackout and whiteout', () => {
    let api!: ReturnType<typeof usePresentationKeys>
    function ApiHost({ props }: { props: PresentationKeysOptions }) {
      api = usePresentationKeys(props)
      return createElement('span')
    }
    const view = renderElement(createElement(ApiHost, { props: options() }))
    act(() => {
      api.toggleLaser()
    })
    expect(api.laser).toBe(true)
    act(() => {
      api.toggleLaser()
    })
    expect(api.laser).toBe(false)
    act(() => {
      api.toggleBlackout()
    })
    expect(api.screenCover).toBe('black')
    act(() => {
      api.toggleWhiteout()
    })
    expect(api.screenCover).toBe('white')
    act(() => {
      api.toggleWhiteout()
    })
    expect(api.screenCover).toBeNull()
    view.unmount()
  })
})


describe('usePresentationKeys — the speaker notes pane', () => {
  it('lets the notes the speaker is reading keep the keys they scroll with', () => {
    const props = options()
    const notes = document.createElement('div')
    notes.setAttribute('data-speaker-notes', '')
    notes.tabIndex = 0
    document.body.append(notes)
    const view = renderElement(createElement(Host, { props }))
    press('ArrowDown', notes)
    press('PageDown', notes)
    press(' ', notes)
    expect(props.goNext, 'a keystroke meant to scroll the notes flipped the slide').not.toHaveBeenCalled()
    expect(props.goPrev).not.toHaveBeenCalled()
    press('ArrowRight', notes)
    expect(props.goNext, 'the sideways turn is not a scroll key, so the show still owns it').toHaveBeenCalledTimes(1)
    view.unmount()
  })
})

// The show hangs its key handling on `window`, which is the only way a keystroke nothing on the
// page claimed still turns a page. That listener is re-armed whenever what it has to know changes —
// and a re-render that changed nothing it reads must not re-arm it. Unmounting is left to the
// afterEach because a case that fails mid-flight would otherwise leave a capture listener on the
// window that preventDefaults the keystroke the next case is still trying to send.
let spied: { add: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> } | null = null
let host: RenderedElement | null = null

// N-17: the card is a mode of the screen the way the grid is, so `?` has to turn it on and off again,
// hand the keystroke back to whatever control is holding it, and take it down with the show.
describe('usePresentationKeys — the key card', () => {
  it('opens and closes the card with ?', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('?')
    expect(state(view.container).keyGuide).toBe('true')
    press('?')
    expect(state(view.container).keyGuide).toBe('false')
    view.unmount()
  })

  it('hands ? to a focused control instead of hijacking the keystroke', () => {
    const input = document.createElement('input')
    document.body.append(input)
    const view = renderElement(createElement(Host, { props: options() }))
    press('?', input)
    expect(state(view.container).keyGuide).toBe('false')
    view.unmount()
  })

  it('goes out with the show, so a finished talk leaves no card on the page', () => {
    const view = renderElement(createElement(Host, { props: options() }))
    press('?')
    view.rerender(createElement(Host, { props: { ...options(), open: false } }))
    expect(state(view.container).keyGuide).toBe('false')
    view.unmount()
  })
})

function keyListenerOps(): { add: number; remove: number } {
  if (!spied) throw new Error('the spies are the point of these cases')
  const isKey = (call: unknown[]) => call[0] === 'keydown'
  return {
    add: spied.add.mock.calls.filter(isKey).length,
    remove: spied.remove.mock.calls.filter(isKey).length,
  }
}

function mountKeys(props: PresentationKeysOptions): RenderedElement {
  host = renderElement(createElement(Host, { props }))
  return host
}

describe('usePresentationKeys — the listener it hangs on the window', () => {
  beforeEach(() => {
    // Spied without an implementation, so the listener still reaches the window and the keystroke
    // below is answered by something.
    spied = { add: vi.spyOn(window, 'addEventListener'), remove: vi.spyOn(window, 'removeEventListener') }
  })

  afterEach(() => {
    host?.unmount()
    host = null
    spied = null
    vi.restoreAllMocks()
  })

  it('hangs one listener and keeps it while the show re-renders under it', () => {
    const view = mountKeys(options())
    expect(keyListenerOps().add).toBe(1)

    for (let render = 0; render < 5; render++) {
      view.rerender(createElement(Host, { props: { ...options(), goNext: vi.fn() } }))
    }
    expect(keyListenerOps().add, 'every re-render of the session re-armed the window listener').toBe(1)
    expect(keyListenerOps().remove).toBe(0)
  })

  it('hands the keystroke to the action the current render passed in', () => {
    const first = vi.fn()
    const view = mountKeys({ ...options(), goNext: first })
    const second = vi.fn()
    view.rerender(createElement(Host, { props: { ...options(), goNext: second } }))

    press('ArrowRight')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})
