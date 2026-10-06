import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals } from '../../../test-render'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'
import { KanbanCard } from './kanban-card'
import { KanbanGalleryView } from './kanban-gallery-view'
import { KanbanListView } from './kanban-list-view'

beforeAll(async () => {
  await initI18n()
})

const columns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'todo', label: 'To Do', color: 'gray' }],
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi-select',
    options: [
      { id: 'bug', label: 'Bug', color: 'red' },
      { id: 'probe', label: 'Probe', color: 'blue' },
    ],
  },
]

const bareCard: KanbanItem = { id: 'c-1', title: 'No tags', properties: {} }
const taggedCard: KanbanItem = { id: 'c-2', title: 'With tags', properties: { tags: ['bug'] } }
const memberCard: KanbanItem = { id: 'c-3', title: 'Owned', properties: { assignee: 'Nora' } }
/** The card the shape assertions read: a status, tags and one subtask, like a board's own. */
const shapeCard: KanbanItem = {
  id: 'card-1',
  title: 'First card',
  properties: { status: 'todo', tags: ['probe'] },
  subtasks: [{ id: 'sub-1', title: 'One', completed: false }],
}

/**
 * One mount for every case in this file, through the same test globals the other component tests
 * install: the card's own shape, the row it reveals on hover, the member it shows, and the two other
 * views that draw the same card.
 */
function mount(element: ReturnType<typeof createElement>) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return {
    container,
    dispose() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function cardProps(
  item: KanbanItem,
  onOpenDetail: (item: KanbanItem) => void,
  overrides: Record<string, unknown> = {},
) {
  return {
    item,
    columns,
    isSelected: false,
    onToggleSelect: vi.fn(),
    onOpenDetail,
    onUpdateTitle: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onMoveColumn: vi.fn(),
    ...overrides,
  }
}

function renderCard(item: KanbanItem = bareCard, overrides: Record<string, unknown> = {}) {
  const onOpenDetail = vi.fn()
  const mounted = mount(createElement(KanbanCard, cardProps(item, onOpenDetail, overrides)))
  return { ...mounted, card: mounted.container.querySelector<HTMLElement>(`[data-item-id="${item.id}"]`)!, onOpenDetail }
}

function galleryData(items: KanbanItem[]): KanbanData {
  return {
    title: 'Board',
    columns,
    views: [{ id: 'view-board', name: '', type: 'board', groupBy: 'status' }],
    items,
  }
}

function renderGallery(items: KanbanItem[]) {
  const onOpenDetail = vi.fn()
  const mounted = mount(
    createElement(KanbanGalleryView, {
      data: galleryData(items),
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
      onOpenDetail,
      onAddItem: vi.fn(),
    }),
  )
  return { ...mounted, onOpenDetail }
}

function renderList(items: KanbanItem[]) {
  const onOpenDetail = vi.fn()
  const mounted = mount(
    createElement(KanbanListView, {
      data: galleryData(items),
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
      onOpenDetail,
      onAddItem: vi.fn(),
    }),
  )
  return { ...mounted, onOpenDetail }
}

function press(target: Element, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  })
}

/** The only `role=img` a card or a gallery tile draws is the one standing for a person. */
function avatarOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="img"]')
}

function cardCheckbox(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    `input[aria-label="${t('preview.kanban_select_card')}"]`,
  )
  if (!el) throw new Error('card checkbox not found')
  return el
}

/** The button a card's title is, which is the control that carries both of the title's gestures. */
function titleOf(card: HTMLElement): HTMLButtonElement {
  return card.querySelector<HTMLButtonElement>('h3 button')!
}

/**
 * The title's field. It is not inside the heading — the heading is what the editor replaces when the
 * title turns into one, so the row the heading stood in is what the field is drawn in.
 */
function titleInput(card: HTMLElement): HTMLInputElement | null {
  return card.querySelector<HTMLInputElement>('input[data-owns-escape]')
}

/** A click with the count a real pointer's click carries. */
function pointerClick(target: Element, detail = 1): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  })
}

/**
 * SH-107's shape, asked of the mounted card rather than of its source: the card is a container of
 * controls and its title is the control that opens the detail. The three views draw the same card,
 * so they are asserted together — the board's card, the gallery's tile and the list's row — because
 * a card surface that drifts back to being one click target is what the raw-control guard, axe's
 * `nested-interactive` and this test are all watching for.
 */
describe('the kanban card is a container whose title opens the detail', () => {
  it('draws no control of its own around the controls it holds', () => {
    const { card } = renderCard(shapeCard)
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
    expect(card.querySelectorAll('[role="button"]').length).toBe(0)
  })

  it('opens the detail from its title, which is a real button', () => {
    const { card, onOpenDetail, dispose } = renderCard(shapeCard)
    const title = card.querySelector('h3 button') as HTMLButtonElement
    expect(title.textContent).toBe(shapeCard.title)
    expect(title.getAttribute('type')).toBe('button')
    act(() => title.click())
    expect(onOpenDetail).toHaveBeenCalledWith(shapeCard)
    dispose()
  })

  it('lets its own controls act without opening the detail', () => {
    const onToggleSelect = vi.fn()
    const { card, onOpenDetail, dispose } = renderCard(shapeCard, { onToggleSelect })
    const select = card.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(select.getAttribute('aria-label')).toBe(t('preview.kanban_select_card'))
    act(() => select.click())
    expect(onToggleSelect).toHaveBeenCalledWith(shapeCard.id)
    expect(onOpenDetail).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the column shortcut, read off the card from the control that was pressed', () => {
    const onMoveColumn = vi.fn()
    const { card, dispose } = renderCard(shapeCard, { onMoveColumn })
    const title = card.querySelector('h3 button') as HTMLButtonElement
    press(title, 'ArrowRight', true)
    expect(onMoveColumn).toHaveBeenCalledWith(shapeCard.id, 'next')
    press(title, 'ArrowLeft', true)
    expect(onMoveColumn).toHaveBeenCalledWith(shapeCard.id, 'prev')
    press(title, 'ArrowRight')
    expect(onMoveColumn).toHaveBeenCalledTimes(2)
    dispose()
  })
})

/**
 * A card's title opens the detail on the click it receives, whatever count the pointer put on it. A
 * double click used to rename instead, and the open waited a quarter second for the second click not
 * to happen — a hold every open paid, and the rename it bought could not run anyway once the dialog's
 * overlay ate the second press (user report 2026-09-23). The wait is gone: every click opens, and
 * rename lives on the pencil beside the title and on `F2`.
 */
describe('a card title opens on one click', () => {
  it('opens the detail on the first click, with no window to wait out', () => {
    const { card, onOpenDetail, dispose } = renderCard(shapeCard)
    pointerClick(titleOf(card))
    expect(onOpenDetail, 'the click opened the detail immediately').toHaveBeenCalledWith(shapeCard)
    dispose()
  })

  it('does not rename on a double click — the pencil and F2 carry rename', () => {
    const { card, dispose } = renderCard(shapeCard)
    pointerClick(titleOf(card), 2)
    act(() => {
      titleOf(card).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    })
    expect(titleInput(card), 'the double click turned the title into an input').toBeNull()
    dispose()
  })
})

/**
 * The doors a rename has that are not the title button: the pencil the title row draws once the card
 * is hovered or its button is focused, and `F2` on the title itself.
 */
describe('a card title renames from its own doors', () => {
  it('renames from the pencil, for a pointer that wants rename without opening the detail', () => {
    const { card, onOpenDetail, dispose } = renderCard(shapeCard)
    const pencil = card.querySelector<HTMLButtonElement>('[data-kanban-rename-card]')!
    expect(pencil.getAttribute('aria-label')).toBe(t('preview.kanban_rename_card'))
    act(() => {
      pencil.click()
    })
    expect(titleInput(card)).not.toBeNull()
    expect(onOpenDetail).not.toHaveBeenCalled()
    dispose()
  })

  it('renames from F2 on the title', () => {
    const { card, onOpenDetail, dispose } = renderCard(shapeCard)
    press(titleOf(card), 'F2')
    expect(titleInput(card)).not.toBeNull()
    expect(onOpenDetail).not.toHaveBeenCalled()
    dispose()
  })
})

/**
 * A card used to draw a fixed set of its properties and nothing else, so a column a reader had added
 * to the board (an estimate, an environment) was reachable only by opening the card. The view now names
 * the columns its cards print (see `card-fields.ts`), and these pin the card end of that: the values
 * under the title, in the view's order, named by the column rather than by the stored value.
 */
describe('the fields a view asks a card to print', () => {
  it('prints them under the title, in the order the view listed them', () => {
    const { card, dispose } = renderCard(shapeCard, { cardFields: ['tags', 'status'] })
    const fields = card.querySelector('[data-kanban-card-fields]')!
    expect([...fields.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['Tags', 'Status'])
    expect([...fields.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['Probe', 'To Do'])
    dispose()
  })

  it('prints them after the description rather than inside it', () => {
    const { card, dispose } = renderCard({ ...shapeCard, description: 'A note' }, { cardFields: ['status'] })
    const fields = card.querySelector('[data-kanban-card-fields]')!
    expect(fields.closest('p')).toBeNull()
    const description = card.querySelector('p')!
    expect(description.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    dispose()
  })

  it('adds nothing at all when the view asks for no fields', () => {
    const { card, dispose } = renderCard(shapeCard)
    expect(card.querySelector('[data-kanban-card-fields]')).toBeNull()
    dispose()
  })

  it('leaves out the fields the card has nothing to say about', () => {
    const { card, dispose } = renderCard(bareCard, { cardFields: ['tags', 'status'] })
    expect(card.querySelector('[data-kanban-card-fields]')).toBeNull()
    dispose()
  })
})

describe('the two other views draw the same card', () => {
  it('draws the gallery tile as the same card', () => {
    const { container, onOpenDetail, dispose } = renderGallery([shapeCard])
    expect(container.querySelector(`[data-item-id="${shapeCard.id}"][role]`)).toBeNull()
    const title = container.querySelector(`[data-item-id="${shapeCard.id}"] h3 button`) as HTMLButtonElement
    expect(title.textContent).toBe(shapeCard.title)
    act(() => title.click())
    expect(onOpenDetail).toHaveBeenCalledWith(shapeCard)
    dispose()
  })

  it('draws the list row as the same card', () => {
    const { container, onOpenDetail, dispose } = renderList([shapeCard])
    expect(container.querySelector(`[data-item-id="${shapeCard.id}"][role]`)).toBeNull()
    // The row leads with a subtask toggle and a selection box, so the title is found by what it says.
    const titles = [...container.querySelectorAll(`[data-item-id="${shapeCard.id}"] button`)].filter(
      (button) => button.textContent === shapeCard.title,
    )
    expect(titles.length).toBe(1)
    act(() => (titles[0] as HTMLButtonElement).click())
    expect(onOpenDetail).toHaveBeenCalledWith(shapeCard)
    dispose()
  })
})

/**
 * The row the card reveals on hover — its checkbox, its tag control and its details button — lives in
 * the card's own flow whether or not the card has tags. It used to be taken out of flow and floated
 * over the card's top edge when there were none, which painted the tag control across the title the
 * moment a reader hovered it (the board draws the same card outside the note, where no prose margin
 * separates the two). A class cannot prove the two boxes do not meet — the browser gate measures that
 * on the running board — so this pins the structure the geometry depends on. The gallery's own tile is
 * the one exception, and it is asserted below: it may float the row, but only over a cover.
 */
describe('KanbanCard hover-only header row', () => {
  it('keeps the header in flow while the card shows no tags', () => {
    const { container, dispose } = renderCard(bareCard)
    const row = cardCheckbox(container).closest('div')!
    expect(row.closest('.absolute')).toBeNull()
    expect(row.contains(container.querySelector('h3'))).toBe(false)
    dispose()
  })

  it('keeps the header in flow while the card shows tags', () => {
    const { container, dispose } = renderCard(taggedCard)
    const row = cardCheckbox(container).closest('div')!
    expect(row.closest('.absolute')).toBeNull()
    dispose()
  })
})

describe('the member an assignee row shows', () => {
  it('names a card avatar with the whole name, not with the two letters it shows', () => {
    const { container, dispose } = renderCard(memberCard)
    expect(avatarOf(container)?.getAttribute('aria-label')).toBe('Nora')
    expect(avatarOf(container)?.textContent).toBe('NO')
    dispose()
  })

  it('draws no avatar on a card nobody is assigned to', () => {
    const { container, dispose } = renderCard(bareCard)
    expect(avatarOf(container)).toBeNull()
    dispose()
  })

  it('names the gallery footer avatar the same way', () => {
    const { container, dispose } = renderGallery([memberCard])
    expect(avatarOf(container)?.getAttribute('aria-label')).toBe('Nora')
    dispose()
  })
})

describe('KanbanGalleryView hover-only header row', () => {
  it('floats the checkbox row over the cover when the tile has one and no tags', () => {
    const { container, dispose } = renderGallery([{ ...bareCard, cover: 'https://example.test/cover.png' }])
    expect(cardCheckbox(container).closest('.absolute')).not.toBeNull()
    dispose()
  })

  it('keeps the checkbox row in flow when the tile has no cover to float it over', () => {
    const { container, dispose } = renderGallery([bareCard])
    expect(cardCheckbox(container).closest('.absolute')).toBeNull()
    dispose()
  })

  it('keeps the gallery header in flow while the card shows tags', () => {
    const { container, dispose } = renderGallery([taggedCard])
    expect(cardCheckbox(container).closest('.absolute')).toBeNull()
    dispose()
  })
})
