/**
 * A board only ever shows the cards inside a 480px canvas, but until now it *mounted* every card on
 * the board to do so. Each surface that owns a scroll area now renders a window of
 * `KANBAN_RENDER_WINDOW` items per list and reveals further ones as the reader approaches the end —
 * by IntersectionObserver when the browser has one, by the tail button when it does not.
 *
 * These mount the real surfaces through `KanbanRoot`, because the window belongs to the list a reader
 * scrolls: the counts are what one column, one group or the whole list puts in the document.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanItem, KanbanViewType } from '../types'
import { KANBAN_RENDER_WINDOW } from './kanban-render-window'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()!.unmount()
  }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** Four columns of `CARDS / 4` cards each, so a window is smaller than one column. */
const CARDS = 400
const PER_COLUMN = CARDS / 4
const STATUSES = ['s1', 's2', 's3', 's4']

function cards(count: number): KanbanItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `i${i}`,
    title: `Card ${i}`,
    properties: { status: STATUSES[i % STATUSES.length] },
  }))
}

function boardData(count: number): KanbanData {
  return {
    title: 'Window',
    activeViewId: 'v-board',
    views: [
      { id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'v-table', name: 'Table', type: 'table', groupBy: 'status' },
      { id: 'v-list', name: 'List', type: 'list' },
      { id: 'v-gallery', name: 'Gallery', type: 'gallery' },
    ],
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: STATUSES.map((id) => ({ id, label: id.toUpperCase(), color: 'blue' })),
      },
    ],
    items: cards(count),
  }
}

/**
 * React owns the input's value, so writing `.value` alone is overwritten on the next render: the native
 * setter is called first, which is what React's own change tracking reads.
 */
function typeInto(field: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function openView(view: KanbanViewType, count: number) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: boardData(count), onUpdateData: vi.fn() }))
  mounted.push(rendered)
  const tab = rendered.container.querySelector<HTMLElement>(`[role="tab"][data-view-type="${view}"]`)
  if (!tab) throw new Error(`the ${view} view rendered no tab`)
  act(() => {
    tab.click()
  })
  return rendered
}

const itemsIn = (root: Element) => root.querySelectorAll('[data-item-id]').length
const tailsIn = (root: Element) => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-kanban-render-more]'))
const columnsOf = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-kanban-group]')).filter((column) => itemsIn(column) > 0)
const hiddenIn = (column: Element) => {
  const tail = tailsIn(column)[0]
  if (!tail) throw new Error('that column renders no tail')
  return tail.textContent ?? ''
}

/** The observers a browser would build, captured so a test can deliver an intersection itself. */
function stubIntersectionObserver() {
  const built: { callback: IntersectionObserverCallback; disconnected: boolean; margin: string }[] = []
  class ObserverStub {
    root = null
    rootMargin = ''
    thresholds: number[] = []
    private readonly index: number
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.index = built.push({ callback, disconnected: false, margin: options?.rootMargin ?? '' }) - 1
    }
    observe() {}
    unobserve() {}
    disconnect() {
      built[this.index]!.disconnected = true
    }
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', ObserverStub)
  return {
    watching: () => built.filter((entry) => !entry.disconnected).length,
    /** The margin the hook asked for, which is what makes it reveal before the reader hits the end. */
    margins: () => built.map((entry) => entry.margin),
    intersect: (index: number) => {
      const record = built[index]
      if (!record) throw new Error(`no observer was built at index ${index}`)
      act(() => {
        record.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
    },
  }
}

// Every case here mounts a real board of `CARDS` cards, so one case is seconds of DOM work rather
// than milliseconds and the suite runs many files at once; the file states its own budget, as the
// tree-walking scans do.
const HEAVY_BOARD = { timeout: 30_000 }

describe('the window a long board renders', HEAVY_BOARD, () => {
  it('mounts one window per column and names what is still hidden', () => {
    const rendered = openView('board', CARDS)
    const bodies = columnsOf(rendered.container)
    expect(bodies).toHaveLength(4)
    for (const column of bodies) {
      expect(itemsIn(column)).toBe(KANBAN_RENDER_WINDOW)
    }
    expect(hiddenIn(bodies[0]!)).toContain(String(PER_COLUMN - KANBAN_RENDER_WINDOW))
  })

  it('leaves a column that fits the window alone', () => {
    const rendered = openView('board', 8)
    expect(itemsIn(columnsOf(rendered.container)[0]!)).toBe(2)
    expect(tailsIn(rendered.container)).toHaveLength(0)
  })

  it('reveals the next window when the reader clicks the tail', async () => {
    const rendered = openView('board', CARDS)
    const first = columnsOf(rendered.container)[0]!
    await act(async () => {
      tailsIn(first)[0].click()
    })
    expect(itemsIn(first)).toBe(KANBAN_RENDER_WINDOW * 2)
    expect(hiddenIn(first)).toContain(String(PER_COLUMN - KANBAN_RENDER_WINDOW * 2))
  })

  it('builds no observer while every column fits its window', () => {
    const observer = stubIntersectionObserver()
    openView('board', 8)
    expect(observer.watching()).toBe(0)
  })
})

describe('how the tail reaches the rest of a column', HEAVY_BOARD, () => {
  it('reveals the next window when an observer reports the tail in view', async () => {
    const observer = stubIntersectionObserver()
    const rendered = openView('board', CARDS)
    expect(observer.watching()).toBe(4)
    for (const margin of observer.margins()) {
      expect(Number(margin.match(/\d+/)?.[0]), 'the tail is watched with a lead, not at the last pixel').toBeGreaterThan(0)
    }
    await act(async () => {
      observer.intersect(0)
    })
    const bodies = columnsOf(rendered.container)
    expect(itemsIn(bodies[0]!)).toBe(KANBAN_RENDER_WINDOW * 2)
    expect(itemsIn(bodies[1]!)).toBe(KANBAN_RENDER_WINDOW)
  })

  it('stops handing out windows once a column is whole', async () => {
    const rendered = openView('board', CARDS)
    for (let round = 0; round < 4; round += 1) {
      const first = columnsOf(rendered.container)[0]!
      await act(async () => {
        tailsIn(first).at(-1)?.click()
      })
    }
    const whole = columnsOf(rendered.container)[0]!
    expect(itemsIn(whole)).toBe(PER_COLUMN)
    expect(tailsIn(whole)).toHaveLength(0)
  })

})

describe('a card filed into a column that is not fully mounted', HEAVY_BOARD, () => {
  it('shows it in its detail dialog, and counts it behind the tail', async () => {
    const rendered = openView('board', CARDS)
    const first = columnsOf(rendered.container)[0]!
    const add = Array.from(first.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === t('preview.kanban_new_item'),
    )
    if (!add) throw new Error('that column offers no add button')
    // The column's own door is a title field now (KU-13): it opens on the button, and the card's window
    // is the Shift+Enter side of the same field — one chord, no second path into the document.
    await act(async () => {
      add.click()
    })
    const field = first.querySelector<HTMLInputElement>(`input[aria-label="${t('preview.kanban_new_item')}"]`)
    if (!field) throw new Error('the add button opened no title field')
    await act(async () => {
      typeInto(field, 'Filed from the column')
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(document.querySelector<HTMLInputElement>(`input[placeholder="${t('preview.kanban_card_title')}"]`)?.value).toBe(
      'Filed from the column',
    )
    expect(hiddenIn(first)).toContain(String(PER_COLUMN - KANBAN_RENDER_WINDOW + 1))
  })
})

describe('every long surface windows its own list', HEAVY_BOARD, () => {
  it.each([
    ['list', KANBAN_RENDER_WINDOW],
    ['gallery', KANBAN_RENDER_WINDOW],
    ['table', KANBAN_RENDER_WINDOW * 4],
  ] as const)('the %s view mounts %i of the 400 cards', (view, expected) => {
    const rendered = openView(view, CARDS)
    expect(rendered.container.querySelectorAll('[data-item-id]').length).toBe(expected)
  })

  it('keeps the table tail inside the row grid', () => {
    const rendered = openView('table', CARDS)
    const tail = tailsIn(rendered.container)[0]
    expect(tail!.closest('[role="cell"]')).not.toBeNull()
    expect(tail!.closest('[role="row"]')).not.toBeNull()
  })
})

describe('a windowed table still answers for the whole group', HEAVY_BOARD, () => {
  /** The tail is the observer's target, so a collapsed group must give its watcher up rather than
   *  leave it pointed at a detached node the reader can never scroll back into. */
  it('stops watching a collapsed group and watches again once it reopens', async () => {
    const observer = stubIntersectionObserver()
    const rendered = openView('table', CARDS)
    expect(observer.watching()).toBe(4)
    const first = columnsOf(rendered.container)[0]!
    const toggle = () => first.querySelector<HTMLButtonElement>('button[aria-expanded]')
    await act(async () => {
      toggle()!.click()
    })
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
    expect(observer.watching()).toBe(3)
    await act(async () => {
      toggle()!.click()
    })
    expect(observer.watching()).toBe(4)
    expect(itemsIn(first)).toBe(KANBAN_RENDER_WINDOW)
  })

  /** A window is a rendering decision, so the readouts that summarise a group must keep counting the
   *  whole group — otherwise hiding rows would quietly change what the board says about them. */
  it('summarises the whole group in its footer bar, not just the mounted window', () => {
    const rendered = openView('table', CARDS)
    const first = columnsOf(rendered.container)[0]!
    const counts = Array.from(first.querySelectorAll('[title]'))
      .map((element) => Number(element.getAttribute('title')?.match(/: (\d+) \(\d+%?\)/)?.[1] ?? NaN))
      .filter((count) => Number.isFinite(count))
    expect(counts).toHaveLength(1)
    expect(counts[0]).toBe(PER_COLUMN)
    expect(itemsIn(first)).toBe(KANBAN_RENDER_WINDOW)
  })

  it('selects every card of a long table, not only the mounted rows', async () => {
    const rendered = openView('table', CARDS)
    const selectAll = rendered.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!selectAll) throw new Error('the table rendered no select-all control')
    await act(async () => {
      selectAll.click()
    })
    expect(document.body.textContent).toContain(t('preview.kanban_batch_selected_count', { count: CARDS }))
  })
})
