import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { WikiLinkHoverCard, type WikiLinkHoverCardState } from './wiki-link-hover-card'
import { applyHighlightToHtml, buildHighlightTerms, peekNoteContent } from './card-content'
import { useLinkHover } from './link-hover'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { useNotes } from '../../store/notes'
import { PINNED_WINDOWS_STORAGE_KEY } from '../../lib/runtime'
import { loadPersisted, usePinnedWindows } from '../../store/pinned-windows'
import { encodeDataValue } from '../../lib/markdown/data-attr'

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver === 'undefined') {
    ;(globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

afterAll(() => {
  vi.restoreAllMocks()
})

const WIKILINK_HTML = `<a class="wikilink" data-wikilink="${encodeDataValue('Note B')}" href="#">[[Note B]]</a>`
const wikilinkHtmlObject = { __html: WIKILINK_HTML }

function summary(id: string, title: string) {
  return {
    id,
    title,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  }
}

function seedNotes(entries: Array<[string, string]>, content: (id: string) => string): void {
  useNotes.setState({
    notes: Object.fromEntries(entries.map(([id, title]) => [id, summary(id, title)])),
    contents: Object.fromEntries(entries.map(([id]) => [id, content(id)])),
  })
}

async function mountCard(state: WikiLinkHoverCardState, props: Partial<ComponentProps<typeof WikiLinkHoverCard>> = {}): Promise<{ root: Root, container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(WikiLinkHoverCard, {
      card: state,
      path: [state.noteId ?? ''].filter(Boolean),
      depth: 1,
      dark: false,
      onClose: () => {},
      onEnter: () => {},
      onLeave: () => {},
      onPin: () => {},
      ...props,
    }))
  })
  return { root, container }
}

function findButtonByLabel(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  )
}

function renderHoverHarness(resolve: (link: HTMLElement) => WikiLinkHoverCardState | null, delay: number) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const refs: { host: HTMLDivElement | null, machine: ReturnType<typeof useLinkHover> | null } = { host: null, machine: null }
  const Harness = () => {
    const machine = useLinkHover({ resolve, delay, enabled: true })
    refs.machine = machine
    return createElement(
      'div',
      null,
      createElement('div', {
        ref: (node: HTMLDivElement | null) => { refs.host = node },
        onMouseMove: machine.handleMouseMove,
        dangerouslySetInnerHTML: wikilinkHtmlObject,
      }),
      machine.card
        ? createElement(WikiLinkHoverCard, {
            card: machine.card,
            path: machine.card.noteId ? [machine.card.noteId] : [],
            depth: 1,
            dark: false,
            onClose: machine.hideNow,
            onEnter: machine.clearPendingHide,
            onLeave: machine.armHide,
            onPin: () => {},
          })
        : null,
    )
  }
  return { root, refs, Harness }
}

function unmountAll(): void {
  document.body.innerHTML = ''
  usePinnedWindows.setState({ items: [], seq: 1, flashId: null })
}

describe('hover machine opens a card from mousemove', () => {
  it('opens a card from a mousemove inside the host', async () => {
    seedNotes([['a', 'Note A'], ['b', 'Note B']], (id) => (id === 'a' ? 'Content of A with [[Note B]] inside.' : 'Content of B'))

    const { root, refs, Harness } = renderHoverHarness((link) => {
      const target = (link.textContent ?? '').replace(/\[\[|\]\]/g, '')
      return { anchor: link, title: target, noteId: 'b', missing: false }
    }, 50)
    await act(async () => root.render(createElement(Harness)))
    const link = refs.host!.querySelector<HTMLElement>('[data-wikilink]')!
    await act(async () => {
      link.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(refs.machine!.card).not.toBeNull()
    expect(document.querySelectorAll('[role="tooltip"]').length).toBeGreaterThan(0)
    act(() => root.unmount())
    unmountAll()
  })
})

describe('hover machine nested and immediate cards', () => {
  it('opens a nested card when hovering a wiki link inside the card body', async () => {
    seedNotes([['a', 'Note A'], ['b', 'Note B']], (id) => (id === 'a' ? 'Content of A with [[Note B]] inside.' : 'Content of B'))

    const anchor = document.createElement('span')
    document.body.appendChild(anchor)
    const state: WikiLinkHoverCardState = { anchor, title: 'Note A', noteId: 'a', missing: false }

    const { root } = await mountCard(state)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    const outer = document.querySelector('[role="tooltip"]')
    expect(outer).not.toBeNull()
    const nestedLink = outer?.querySelector<HTMLElement>('.wiki-hover-body a[data-wikilink]')
    expect(nestedLink?.textContent).toBe('Note B')

    await act(async () => {
      nestedLink!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 420))
    })

    const cards = [...document.querySelectorAll('[role="tooltip"]')]
    expect(cards.length).toBe(2)
    act(() => root.unmount())
    unmountAll()
  })

  it('does not open a nested card for a link back to a note already on the path', async () => {
    seedNotes([['a', 'Note A']], () => 'Note A mentions [[Note A]] itself.')
    const anchor = document.createElement('span')
    document.body.appendChild(anchor)

    const { root } = await mountCard({ anchor, title: 'Note A', noteId: 'a', missing: false })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const selfLink = document.querySelector<HTMLElement>('[role="tooltip"] .wiki-hover-body a[data-wikilink]')
    expect(selfLink?.textContent).toBe('Note A')
    await act(async () => {
      selfLink!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 420))
    })
    expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1)
    act(() => root.unmount())
    unmountAll()
  })

  it('opens the card immediately when proposing with the immediate option', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')

    const { root, refs, Harness } = renderHoverHarness(
      (link) => ({ anchor: link, title: 'Note A', noteId: 'a', missing: false }),
      10000,
    )
    await act(async () => root.render(createElement(Harness)))
    const link = refs.host!.querySelector<HTMLElement>('[data-wikilink]')!
    expect(refs.machine!.card).toBeNull()
    await act(async () => {
      refs.machine!.propose(link, { immediate: true })
    })
    expect(refs.machine!.card).not.toBeNull()
    act(() => root.unmount())
    unmountAll()
  })
})

describe('hover machine hide races', () => {
  it('keeps the card when the same link is re-proposed while a hide is pending', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')

    const { root, refs, Harness } = renderHoverHarness(
      (anchor) => ({ anchor, title: 'Note A', noteId: 'a', missing: false }),
      50,
    )
    await act(async () => root.render(createElement(Harness)))
    const link = refs.host!.querySelector<HTMLElement>('[data-wikilink]')!
    await act(async () => {
      refs.machine!.propose(link, { immediate: true })
    })
    expect(refs.machine!.card).not.toBeNull()
    await act(async () => {
      refs.machine!.armHide()
      refs.machine!.propose(link, { immediate: true })
      await new Promise((resolve) => setTimeout(resolve, 420))
    })
    expect(refs.machine!.card).not.toBeNull()
    act(() => root.unmount())
    unmountAll()
  })

  it('promotes the card to a pinned window when the pin button is clicked', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')

    const anchor = document.createElement('span')
    document.body.appendChild(anchor)
    const state: WikiLinkHoverCardState = { anchor, title: 'Note A', noteId: 'a', missing: false }
    let pinnedCard: WikiLinkHoverCardState | null = null

    const { root } = await mountCard(state, { onPin: (card) => { pinnedCard = card } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    const pinButton = findButtonByLabel('preview.pin_card')
    expect(pinButton).not.toBeNull()
    await act(async () => {
      pinButton!.click()
    })
    expect(pinnedCard).toEqual(state)
    act(() => root.unmount())
    unmountAll()
  })

  it('hides the card when the feature is switched off', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')
    const { root, refs, Harness } = renderHoverHarness(
      (anchor) => ({ anchor, title: 'Note A', noteId: 'a', missing: false }),
      20,
    )
    await act(async () => root.render(createElement(Harness)))
    const link = refs.host!.querySelector<HTMLElement>('[data-wikilink]')!
    await act(async () => {
      refs.machine!.propose(link, { immediate: true })
    })
    expect(refs.machine!.card).not.toBeNull()
    act(() => refs.machine!.hideNow())
    expect(refs.machine!.card).toBeNull()
    act(() => root.unmount())
    unmountAll()
  })
})

describe('pinned card close and headline highlight', () => {
  it('closes a pinned window via its close button', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')

    const anchor = document.createElement('span')
    document.body.appendChild(anchor)
    const state: WikiLinkHoverCardState = { anchor, title: 'Note A', noteId: 'a', missing: false }
    let closed = false

    const { root } = await mountCard(state, {
      pinned: true,
      pinnedInit: { id: 1, noteId: 'a', title: 'Note A', missing: false, x: 40, y: 80, width: 340, height: 0, z: 1 },
      onClose: () => { closed = true },
    })

    const closeButton = findButtonByLabel('common.close')
    await act(async () => {
      closeButton!.click()
    })
    expect(closed).toBe(true)
    act(() => root.unmount())
    unmountAll()
  })

  it('shows the not-created state for a missing note', async () => {
    seedNotes([], () => '')
    const anchor = document.createElement('span')
    document.body.appendChild(anchor)

    const { root } = await mountCard({ anchor, title: 'Ghost', noteId: null, missing: true })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('preview.note_does_not_exist')
    act(() => root.unmount())
    unmountAll()
  })

  it('brings a stored window back inside the viewport when the screen shrank', async () => {
    seedNotes([['a', 'Note A']], () => 'Content of A')
    const anchor = document.createElement('span')
    document.body.appendChild(anchor)

    const { root } = await mountCard({ anchor, title: 'Note A', noteId: 'a', missing: false }, {
      pinned: true,
      pinnedInit: { id: 1, noteId: 'a', title: 'Note A', missing: false, x: 99_999, y: 99_999, width: 340, height: 300, z: 1 },
    })
    const card = document.querySelector<HTMLElement>('[role="dialog"]')!
    const left = Number.parseFloat(card.style.left)
    const top = Number.parseFloat(card.style.top)
    expect(Number.isFinite(left)).toBe(true)
    expect(left + Number.parseFloat(card.style.width)).toBeLessThanOrEqual(window.innerWidth)
    expect(top).toBeLessThan(window.innerHeight)
    act(() => root.unmount())
    unmountAll()
  })

  it('highlights headline matches inside the rendered card body', async () => {
    const terms = buildHighlightTerms('Welcome to Inkstone')
    expect(terms).toContain('Welcome to Inkstone')
    expect(terms).toContain('Welcome')
    expect(terms).toContain('Inkstone')

    const html = '<div><p>This is a Welcome to Inkstone tour.</p><p>Another Inkstone paragraph</p></div>'
    const highlighted = applyHighlightToHtml(html, terms)
    const marks = [...new DOMParser().parseFromString(highlighted, 'text/html').querySelectorAll('mark')]
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(highlighted).toContain('class="card-hl"')
  })

  it('does not highlight inside code blocks', () => {
    const terms = buildHighlightTerms('MyNote')
    const html = '<div><p>MyNote shown here</p><pre><code>const MyNote = 1; MyNote++</code></pre></div>'
    const highlighted = applyHighlightToHtml(html, terms)
    const marks = [...new DOMParser().parseFromString(highlighted, 'text/html').querySelectorAll('mark')]
    expect(marks.length).toBe(1)
    expect(highlighted).toContain('<code>const MyNote = 1; MyNote++</code>')
  })
})

describe('card content resolution', () => {
  it('reads an open note from the live buffer before anything else', async () => {
    seedNotes([['a', 'Note A']], () => 'Live buffer text')
    const getContent = vi.spyOn(localDb, 'getContent')
    const getNote = vi.spyOn(api.notes, 'get')

    await expect(peekNoteContent('a')).resolves.toBe('Live buffer text')
    expect(getContent).not.toHaveBeenCalled()
    expect(getNote).not.toHaveBeenCalled()
  })

  it('falls back to the local cache and then to the api', async () => {
    useNotes.setState({ notes: { a: summary('a', 'Note A') }, contents: {} })
    vi.spyOn(localDb, 'getContent').mockResolvedValue(undefined)
    const getNote = vi.spyOn(api.notes, 'get').mockResolvedValue({ ...summary('a', 'Note A'), content: 'Fetched from the server' })

    await expect(peekNoteContent('a')).resolves.toBe('Fetched from the server')
    expect(getNote).toHaveBeenCalledWith('a')

    useNotes.setState({ notes: { b: summary('b', 'Note B') }, contents: {} })
    vi.spyOn(localDb, 'getContent').mockResolvedValue({ content: 'Cached offline', rev: 1, updatedAt: 0 })
    await expect(peekNoteContent('b')).resolves.toBe('Cached offline')
    vi.restoreAllMocks()
  })
})

describe('pinned windows store behavior', () => {
  it('pins, restacks, moves and closes windows through the persisted store', () => {
    usePinnedWindows.setState({ items: [], seq: 1 })
    const anchor = document.createElement('span')
    const card: WikiLinkHoverCardState = { anchor, title: 'Note A', noteId: 'a', missing: false, headline: 'A' }
    const rect = { left: 10, top: 20, width: 300, height: 0, right: 310, bottom: 20 } as DOMRect

    usePinnedWindows.getState().pin(card, rect)
    usePinnedWindows.getState().pin({ ...card, title: 'Note B', noteId: 'b' }, { ...rect, left: 50 } as DOMRect)
    let items = usePinnedWindows.getState().items
    expect(items).toHaveLength(2)
    expect(items[1]!.z).toBeGreaterThan(items[0]!.z)

    usePinnedWindows.getState().bringToFront(items[0]!.id)
    items = usePinnedWindows.getState().items
    expect(items[0]!.z).toBeGreaterThan(items[1]!.z)

    usePinnedWindows.getState().updateGeometry(items[0]!.id, { x: 111, y: 222, width: 400, height: 300 })
    items = usePinnedWindows.getState().items
    expect(items[0]!.x).toBe(111)
    expect(items[0]!.height).toBe(300)

    usePinnedWindows.getState().closeFront()
    items = usePinnedWindows.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('Note B')

    usePinnedWindows.getState().closeAll()
    expect(usePinnedWindows.getState().items).toHaveLength(0)
  })

  it('refuses to pin beyond the window cap', () => {
    usePinnedWindows.setState({ items: [], seq: 1 })
    const anchor = document.createElement('span')
    const rect = { left: 10, top: 20, width: 300, height: 0, right: 310, bottom: 20 } as DOMRect
    for (let index = 0; index < 20; index++) {
      usePinnedWindows.getState().pin({ anchor, title: `Note ${index}`, noteId: `n${index}`, missing: false }, rect)
    }
    expect(usePinnedWindows.getState().items).toHaveLength(12)
    usePinnedWindows.setState({ items: [], seq: 1 })
  })

  it('focuses and flashes a pinned window by its note id', () => {
    usePinnedWindows.setState({ items: [], seq: 1, flashId: null })
    const anchor = document.createElement('span')
    const rect = { left: 10, top: 20, width: 300, height: 0, right: 310, bottom: 20 } as DOMRect
    const card: WikiLinkHoverCardState = { anchor, title: 'Note A', noteId: 'a', missing: false }
    usePinnedWindows.getState().pin(card, rect)
    usePinnedWindows.getState().pin({ ...card, title: 'Note B', noteId: 'b' }, { ...rect, left: 50 } as DOMRect)

    expect(usePinnedWindows.getState().focusPinnedByNote('missing')).toBe(false)
    expect(usePinnedWindows.getState().focusPinnedByNote('a')).toBe(true)
    const items = usePinnedWindows.getState().items
    expect(items[0]!.z).toBeGreaterThan(items[1]!.z)
    expect(usePinnedWindows.getState().flashId).toBe(items[0]!.id)
    usePinnedWindows.getState().closeAll()
  })
})

describe('pinned windows persistence', () => {
  it('restores pinned windows from local storage', () => {
    localStorage.setItem(PINNED_WINDOWS_STORAGE_KEY, JSON.stringify({
      seq: 7,
      items: [
        { id: 3, noteId: 'a', title: 'Note A', missing: false, x: 10, y: 20, width: 340, height: 200, z: 2 },
        { id: 'bad', noteId: 5, title: 9, missing: 'x', x: 'nope', y: 0, width: 0, height: 0, z: 0 },
        { id: 4, noteId: null, title: 'Missing note', missing: true, x: 5, y: 5, width: 200, height: 100, z: 1 },
      ],
    }))
    const restored = loadPersisted()
    expect(restored.items).toHaveLength(2)
    expect(restored.items[0]).toMatchObject({ id: 3, noteId: 'a', title: 'Note A', z: 2 })
    expect(restored.items[1]).toMatchObject({ id: 4, noteId: null, missing: true })
    expect(restored.seq).toBe(7)
  })

  it('drops a payload that is not shaped like a window list', () => {
    localStorage.setItem(PINNED_WINDOWS_STORAGE_KEY, '[1,2,3]')
    expect(loadPersisted()).toEqual({ items: [], seq: 1 })
    localStorage.setItem(PINNED_WINDOWS_STORAGE_KEY, 'not json')
    expect(loadPersisted()).toEqual({ items: [], seq: 1 })
    localStorage.removeItem(PINNED_WINDOWS_STORAGE_KEY)
  })

  it('derives the next id when the stored sequence is unusable', () => {
    localStorage.setItem(PINNED_WINDOWS_STORAGE_KEY, JSON.stringify({
      items: [{ id: 9, noteId: 'a', title: 'A', missing: false, x: 0, y: 0, width: 10, height: 10, z: 1 }],
    }))
    const restored = loadPersisted()
    expect(restored.seq).toBe(10)
    localStorage.removeItem(PINNED_WINDOWS_STORAGE_KEY)
  })
})
