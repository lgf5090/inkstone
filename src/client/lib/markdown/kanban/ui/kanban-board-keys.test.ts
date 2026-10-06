/**
 * KU-14. A board full of cards is the one surface where the pointer is a poor way to get around: the
 * cards are small, they are laid out in two dimensions, and reaching the ninth one means scrolling a
 * column. The arrows walk the focus from card to card instead — down and up inside a column, sideways
 * to the neighbouring column at the same position — and `N` and `/` reach the board's two doors
 * without leaving the keyboard.
 *
 * These drive the real board root, because the thing being asserted is where the focus ends up in the
 * document the reader is looking at, and the scoping: the listener is on the board's own container, so
 * a key press that happened outside this board never reaches it. That is the difference between this
 * table and the app's global hotkey registry, and it is what keeps `N` from adding a card to the board
 * in the note behind the one being read.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

function boardData(extra: Partial<KanbanData> = {}): KanbanData {
  return {
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'todo', label: 'To Do', color: 'gray' },
          { id: 'doing', label: 'Doing', color: 'blue' },
          { id: 'done', label: 'Done', color: 'green' },
        ],
      },
    ],
    items: [
      { id: 'a', title: 'Card a', properties: { status: 'todo' } },
      { id: 'b', title: 'Card b', properties: { status: 'todo' } },
      { id: 'c', title: 'Card c', properties: { status: 'doing' } },
    ],
    views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }],
    ...extra,
  }
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(data: KanbanData = boardData(), onUpdateData = vi.fn()) {
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

/** The control arrows focus: the card's own title button, which is also what Enter opens. */
function titleButton(container: HTMLElement, itemId: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-item-id="${itemId}"] h3 button`)
  if (!button) throw new Error(`card ${itemId} draws no title button`)
  return button
}

/** Puts the reader on a card the way the arrows leave them, then presses a key there. */
function press(container: HTMLElement, itemId: string, key: string, init: KeyboardEventInit = {}): boolean {
  const button = titleButton(container, itemId)
  button.focus()
  let event: KeyboardEvent | null = null
  act(() => {
    event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    button.dispatchEvent(event)
  })
  return event!.defaultPrevented
}

/** The card the focus is in, read off the document rather than from the keyboard event. */
function focusedCard(): string {
  const active = document.activeElement
  const card = active instanceof Element ? active.closest('[data-item-id]') : null
  return card?.getAttribute('data-item-id') ?? (active ? `<${active.tagName.toLowerCase()}>` : 'nothing')
}

/** A key press that happened somewhere on the board with no card under it. */
function pressOnBoardWhitespace(container: HTMLElement, key: string): void {
  const root = container.querySelector<HTMLElement>('[data-kanban-board]')?.parentElement
  if (!root) throw new Error('the board draws no root to press keys on')
  act(() => {
    root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** A key press from a card, which is how the board tells which column the reader is standing in. */
function pressOnBoardWhitespaceFrom(container: HTMLElement, itemId: string, key: string): void {
  const card = container.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  if (!card) throw new Error(`no card ${itemId} to press from`)
  act(() => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** The title field a column's composer opens, if one is drawn. */
function quickAddField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[data-kanban-new-item]')
}

describe('the arrows walk the focus from card to card', () => {
  it('moves down and up inside one column', () => {
    const { container } = mountBoard()
    press(container, 'a', 'ArrowDown')
    expect(focusedCard()).toBe('b')
    press(container, 'b', 'ArrowUp')
    expect(focusedCard()).toBe('a')
  })

  it('stops at the ends of a column and leaves those presses to the browser', () => {
    const { container } = mountBoard()
    // Nothing above the first card: the arrow scrolls the column instead of being swallowed. The one
    // press that did move had to be consumed, or the column would scroll as well as hand the focus on.
    expect(press(container, 'a', 'ArrowUp')).toBe(false)
    expect(focusedCard()).toBe('a')
    expect(press(container, 'b', 'ArrowDown')).toBe(false)
    expect(focusedCard()).toBe('b')
    expect(press(container, 'a', 'ArrowDown')).toBe(true)
  })

  it('moves to the neighbouring column at the same position', () => {
    const { container } = mountBoard()
    press(container, 'a', 'ArrowRight')
    expect(focusedCard()).toBe('c')
    press(container, 'c', 'ArrowLeft')
    expect(focusedCard()).toBe('a')
  })

  it('lands on the last card of a shorter neighbour rather than nowhere', () => {
    const { container } = mountBoard()
    // `doing` holds one card while `todo` holds two: the second card of `todo` walks onto it.
    press(container, 'b', 'ArrowRight')
    expect(focusedCard()).toBe('c')
  })

  it('skips a neighbour with no cards in it, and the columns past the ends', () => {
    const data = boardData({
      items: [
        { id: 'a', title: 'Card a', properties: { status: 'todo' } },
        { id: 'c', title: 'Card c', properties: { status: 'done' } },
      ],
    })
    const { container } = mountBoard(data)
    expect(press(container, 'a', 'ArrowLeft')).toBe(false)
    expect(focusedCard()).toBe('a')
    // `doing` is on screen with nothing in it, so the press is the browser's to spend on scrolling.
    expect(press(container, 'a', 'ArrowRight')).toBe(false)
    expect(focusedCard()).toBe('a')
  })
})

describe('the modified arrows belong to the card, not to the walk', () => {
  it('leaves those presses to the card, which owns them', () => {
    const { container, onUpdateData } = mountBoard()
    // `Shift`+arrow is the card's own *move this card* gesture, read off the card itself. The keyboard
    // here must not also walk the focus on the same press, or a reader who meant to move a card would
    // land somewhere else entirely — the two gestures have to stay one key apart. The focus is spied
    // on rather than read afterwards, because moving a card to another column remounts it and the
    // browser's focus goes with the node: what is asserted is that this layer never moved it.
    const send = (button: HTMLElement, init: KeyboardEventInit) => {
      act(() => {
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...init }))
      })
    }
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      const card = titleButton(container, 'a')
      card.focus()
      focus.mockClear()
      send(card, { key: 'ArrowRight', shiftKey: true })
      expect(focus, 'the navigation moved the focus on the move gesture').not.toHaveBeenCalled()
      expect(onUpdateData, 'the card did not move').toHaveBeenCalled()
      send(card, { ctrlKey: true })
      expect(focus, 'a modified arrow walked the focus').not.toHaveBeenCalled()
    } finally {
      focus.mockRestore()
    }
    // The plain arrow is still the board's once the modifiers are gone (the rest of this file holds
    // it to that), so `b` — the card the move left behind in the first column — walks on as usual.
    press(container, 'b', 'ArrowRight')
    expect(['a', 'c'], 'the plain arrow stopped walking once the modifiers were let go').toContain(focusedCard())
  })
})

describe('the board answers its own chords, and only inside itself', () => {
  it('opens a column\u2019s own composer on N rather than filing a card behind a dialog', () => {
    const { container, onUpdateData } = mountBoard()
    pressOnBoardWhitespace(container, 'n')
    // The chord presses the same door the footer draws (KU-13): a title field, in the column, with the
    // focus in it. Filing a card instead is what this used to do through the header's button, and that
    // path opens the new card's window over the board — the reader is then typing a title behind a modal,
    // and every assertion after this one in the browser gate was looking at that modal's scrim.
    const field = quickAddField(container)
    expect(field, 'N opened no title field').not.toBeNull()
    expect(document.activeElement, 'the field opened without the focus').toBe(field)
    expect(onUpdateData, 'N wrote a card before a title was even typed').not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]'), 'N opened a window over the board').toBeNull()
  })

  it('opens it in the column the reader is standing in', () => {
    const { container } = mountBoard()
    press(container, 'c', 'ArrowUp')
    pressOnBoardWhitespaceFrom(container, 'c', 'n')
    const field = quickAddField(container)
    expect(field?.closest('[data-kanban-group]')?.getAttribute('data-kanban-group'), 'the field opened in another column').toBe('doing')
  })

  it('opens the search field on slash and puts the reader in it', () => {
    const { container } = mountBoard()
    pressOnBoardWhitespace(container, '/')
    const field = container.querySelector<HTMLInputElement>('[data-kanban-search-input]')
    expect(field, 'slash opened no search field').not.toBeNull()
    expect(document.activeElement, 'the field opened without the focus').toBe(field)
  })

  it('puts the reader back in the field on a second slash', () => {
    const { container } = mountBoard()
    pressOnBoardWhitespace(container, '/')
    const field = container.querySelector<HTMLInputElement>('[data-kanban-search-input]')!
    act(() => {
      container.querySelector<HTMLElement>('[data-kanban-board]')?.click()
    })
    pressOnBoardWhitespace(container, '/')
    expect(container.querySelectorAll('[data-kanban-search-input]').length, 'a second field was opened').toBe(1)
    expect(document.activeElement).toBe(field)
  })

})

describe('the chords stay out of everyone else\'s way', () => {
  it('ignores the board it is not in', () => {
    const { container, onUpdateData } = mountBoard()
    // The app's own key presses land on the body; a listener on the board container never hears them,
    // which is what keeps `N` from filing a card into a note the reader is not working in.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }))
    })
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(container.querySelector('[data-kanban-search-input]')).toBeNull()
  })

  it('leaves the keys that belong to a field alone', () => {
    const { container, onUpdateData } = mountBoard()
    // The rename field stands in the card itself, opened from the pencil the title row carries: a
    // field the board can see the keys of, exactly the one `n` must not act on.
    const pencil = container.querySelector<HTMLButtonElement>('[data-item-id="a"] [data-kanban-rename-card]')
    expect(pencil, 'card a draws no rename pencil').not.toBeNull()
    act(() => { pencil!.click() })
    const field = container.querySelector<HTMLInputElement>('input[data-owns-escape]')
    expect(field, 'no card title field was opened to type in').not.toBeNull()
    act(() => {
      field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true }))
    })
    expect(onUpdateData, 'typing n in a card title filed a card').not.toHaveBeenCalled()
    act(() => {
      field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(onUpdateData, 'Delete in a field deleted the card standing behind it').not.toHaveBeenCalled()
  })
})

describe('the delete keys flag the card the reader is standing on', () => {
  it('soft-deletes the focused card and leaves its neighbours alone', () => {
    const { container, onUpdateData } = mountBoard()
    expect(press(container, 'b', 'Delete'), 'the press was left to the browser').toBe(true)
    const committed = onUpdateData.mock.calls.at(-1)![0] as KanbanData
    expect(committed.items.find((item) => item.id === 'b')!.deleted).toBe(true)
    expect(committed.items.find((item) => item.id === 'a')!.deleted).toBeUndefined()
  })

  it('answers to Backspace the same way', () => {
    const { container, onUpdateData } = mountBoard()
    press(container, 'a', 'Backspace')
    const committed = onUpdateData.mock.calls.at(-1)![0] as KanbanData
    expect(committed.items.find((item) => item.id === 'a')!.deleted).toBe(true)
  })

  it('deletes nothing when the focus is not on a card', () => {
    const { container, onUpdateData } = mountBoard()
    pressOnBoardWhitespace(container, 'Delete')
    expect(onUpdateData, 'a press with no card under it deleted something').not.toHaveBeenCalled()
    expect(container.querySelector('[data-item-id="b"]'), 'the board lost cards it should not have').not.toBeNull()
  })
})

describe('a banded board keeps the arrows inside the band they are read in', () => {
  it('walks down the band rather than into the one below it', () => {
    const data = boardData({
      columns: [
        { id: 'title', name: 'Title', type: 'title' },
        { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
        {
          id: 'area',
          name: 'Area',
          type: 'select',
          options: [
            { id: 'front', label: 'Front end', color: 'blue' },
            { id: 'back', label: 'Back end', color: 'green' },
          ],
        },
      ],
      items: [
        { id: 'a', title: 'Card a', properties: { status: 'todo', area: 'front' } },
        { id: 'b', title: 'Card b', properties: { status: 'todo', area: 'front' } },
        { id: 'c', title: 'Card c', properties: { status: 'todo', area: 'back' } },
      ],
      views: [{ id: 'v-board', name: 'Board', type: 'board', groupBy: 'status', swimlaneBy: 'area' }],
    })
    const { container } = mountBoard(data)
    expect(container.querySelectorAll('[data-kanban-band]').length, 'the board drew no bands to read').toBe(2)
    press(container, 'a', 'ArrowDown')
    expect(focusedCard(), 'the focus left the band it was in').toBe('b')
    // `c` stands in the column below, in the next band: down from the last card of a band is the
    // browser's press, not a jump across the board's other axis.
    expect(press(container, 'b', 'ArrowDown')).toBe(false)
    expect(focusedCard()).toBe('b')
  })
})
