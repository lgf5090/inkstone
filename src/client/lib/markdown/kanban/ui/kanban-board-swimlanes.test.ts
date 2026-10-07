/**
 * F-10. Banding adds a second answer about the same cards, so it is read off the board a reader
 * mounts: which row a card appears in, what one cell of that row holds, and what a single gesture
 * writes when the card moves between rows. A column is titled once above the grid rather than in every
 * cell, because the same title repeated per band would say one thing as many times as there are bands.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { formatKanbanGroupLabel } from '../i18n-helpers'
import type { KanbanData, KanbanItem, KanbanProperty, KanbanView } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'
const DOING = 'doing'
const UNASSIGNED = '__none__'

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: TODO, label: 'To Do', color: 'gray' },
    { id: DOING, label: 'In Progress', color: 'blue' },
  ],
}

const ownerColumn: KanbanProperty = {
  id: 'owner',
  name: 'Owner',
  type: 'select',
  options: [
    { id: 'alice', label: 'Alice', color: 'blue' },
    { id: 'bob', label: 'Bob', color: 'green' },
  ],
}

function card(id: string, properties: Record<string, unknown>): KanbanItem {
  return { id, title: `Card ${id}`, properties }
}

/** `__none__` is unshifted to the front, so the rows come out unassigned, Alice, Bob. */
function bandedData(over: Partial<KanbanData['views'][number]> = {}): KanbanData {
  return {
    columns: [{ id: 'title', name: 'Title', type: 'title' }, statusColumn, ownerColumn],
    items: [
      card('a1', { status: TODO, owner: 'alice' }),
      card('a2', { status: TODO, owner: 'alice' }),
      card('b1', { status: TODO, owner: 'bob' }),
      card('d1', { status: DOING, owner: 'bob' }),
      card('n1', { status: TODO }),
    ],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status', swimlaneBy: 'owner', ...over }],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountKanban(data: KanbanData) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function lastCommit(onUpdateData: ReturnType<typeof vi.fn>): KanbanData | undefined {
  const calls = onUpdateData.mock.calls
  return calls.length > 0 ? (calls.at(-1) as [KanbanData])[0] : undefined
}

function committedView(onUpdateData: ReturnType<typeof vi.fn>): KanbanView | undefined {
  return lastCommit(onUpdateData)?.views.find((view) => view.id === 'v')
}

function writtenCard(onUpdateData: ReturnType<typeof vi.fn>, id: string): KanbanItem | undefined {
  return lastCommit(onUpdateData)?.items.find((item) => item.id === id)
}

function cell(container: HTMLElement, groupKey: string, laneKey: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(
    `[data-kanban-group="${groupKey}"][data-kanban-lane="${laneKey}"]`,
  )
  expect(node, `no cell for ${groupKey} in band ${laneKey}`).not.toBeNull()
  return node!
}

function cardIdsIn(node: HTMLElement): string[] {
  return [...node.querySelectorAll<HTMLElement>('[data-item-id]')].map((card) => card.dataset.itemId!)
}

function stripCell(container: HTMLElement, groupKey: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-kanban-strip] [data-kanban-group="${groupKey}"]`)
  expect(node, `the strip has no column ${groupKey}`).not.toBeNull()
  return node!
}

function pressShiftArrow(itemId: string, key: 'ArrowRight' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown'): void {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  expect(card, `card ${itemId} is not in the document`).not.toBeNull()
  const origin = card!.querySelector<HTMLElement>('button') ?? card!
  origin.focus()
  act(() => {
    origin.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }))
  })
}

function liveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[data-kanban-board] [data-kanban-move-announcement]')
  expect(region, 'the board renders no polite live region').not.toBeNull()
  return region!
}

function openStripMenu(container: HTMLElement, groupKey: string): HTMLElement {
  const trigger = stripCell(container, groupKey).querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
  expect(trigger, `column ${groupKey} has no menu trigger on the strip`).not.toBeNull()
  act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog, 'the column menu did not open').not.toBeNull()
  return dialog!
}

/** What a row is called out loud: the field's own value, except for the row that has none. */
function bandLabel(laneKey: string, label: string): string {
  return laneKey === UNASSIGNED ? t('preview.kanban_swimlane_none') : formatKanbanGroupLabel(laneKey, label)
}

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-kanban-band]')].map((band) => band.dataset.kanbanBand!)
}

/** The board's own options panel, which is where a reader asks for rows in the first place. */
function openViewOptions(container: HTMLElement): HTMLElement {
  const label = t('preview.kanban_group_by')
  const trigger = container.querySelector<HTMLElement>(`[data-kanban-header] button[aria-label="${label}"]`)
  expect(trigger, 'the board offers no view options').not.toBeNull()
  act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  const dialog = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`)
  expect(dialog, 'the view options did not open').not.toBeNull()
  return dialog!
}

function swimlaneSelect(dialog: HTMLElement): HTMLSelectElement {
  const select = [...dialog.querySelectorAll<HTMLSelectElement>('select')]
    .find((field) => field.labels?.[0]?.textContent === t('preview.kanban_swimlane_by'))
  expect(select, 'the panel has no field named after the thing it layers by').not.toBeNull()
  return select!
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('the rows a banded board draws', () => {
  it('cuts one row per value of the field, with the cards nobody owns in their own', () => {
    const { container } = mountKanban(bandedData())
    expect(rows(container)).toEqual([UNASSIGNED, 'alice', 'bob'])
  })

  it('titles every column once, above the rows', () => {
    const { container } = mountKanban(bandedData())
    const titled = [...container.querySelectorAll<HTMLElement>('[data-kanban-strip] [data-kanban-group]')]
    expect(titled.map((node) => node.dataset.kanbanGroup)).toEqual([TODO, DOING])
    expect(stripCell(container, TODO).querySelector('[data-kanban-count]')?.textContent).toBe('4')
  })

  it('gives a cell only that column within its own band', () => {
    const { container } = mountKanban(bandedData())
    expect(cardIdsIn(cell(container, TODO, 'alice'))).toEqual(['a1', 'a2'])
    expect(cardIdsIn(cell(container, TODO, 'bob'))).toEqual(['b1'])
    expect(cardIdsIn(cell(container, DOING, 'bob'))).toEqual(['d1'])
  })

  it('draws a cell of a band without repeating the column it belongs to', () => {
    const { container } = mountKanban(bandedData())
    expect(cell(container, TODO, 'alice').querySelector('[data-kanban-count]')).toBeNull()
    expect(cell(container, TODO, 'alice').querySelector('[data-kanban-lane]')).toBeNull()
  })

  it('names the row nobody owns for having no owner, not for having no status', () => {
    const { container } = mountKanban(bandedData())
    const unassigned = container.querySelector<HTMLElement>(`[data-kanban-band="${UNASSIGNED}"]`)
    expect(unassigned?.getAttribute('role')).toBe('group')
    expect(unassigned?.getAttribute('aria-label')).toBe(bandLabel(UNASSIGNED, 'No Status'))
    expect(unassigned?.getAttribute('aria-label')).not.toBe(t('preview.kanban_no_status'))
    // The row says how many cards it holds, because no column pill adds that row up.
    expect(unassigned?.querySelector('[data-kanban-lane-count]')?.textContent).toBe('1')
    const alice = container.querySelector<HTMLElement>(`[data-kanban-band="alice"]`)
    expect(alice?.querySelector('[data-kanban-lane-count]')?.textContent).toBe('2')
  })
})

describe('one cell of the grid, and a board with no cells to cut', () => {
  it('gives a band a cell for every column, holding only what that row has in it', () => {
    const data = bandedData()
    // A status the board has no column for, owned by someone who does have a row: the strip gains a
    // No Status column, and the rows that hold nothing of it still have to answer for it.
    data.items = [...data.items, card('x1', { status: 'archived', owner: 'bob' })]
    const { container } = mountKanban(data)
    expect(rows(container)).toEqual([UNASSIGNED, 'alice', 'bob'])
    expect([...container.querySelectorAll<HTMLElement>('[data-kanban-strip] [data-kanban-group]')]
      .map((node) => node.dataset.kanbanGroup)).toEqual([UNASSIGNED, TODO, DOING])
    expect(cardIdsIn(cell(container, UNASSIGNED, 'bob'))).toEqual(['x1'])
    expect(cell(container, '__none__', 'alice')).toBeTruthy()
    expect(cardIdsIn(cell(container, UNASSIGNED, 'alice'))).toEqual([])
  })

  it('leaves a board nobody banded a single row of columns', () => {
    const { container } = mountKanban(bandedData({ swimlaneBy: undefined }))
    expect(rows(container)).toEqual([])
    const todo = container.querySelector<HTMLElement>(`[data-kanban-group="${TODO}"]`)
    expect(cardIdsIn(todo!)).toEqual(['a1', 'a2', 'b1', 'n1'])
    expect(todo!.querySelector('[data-kanban-count]')).not.toBeNull()
  })
})

describe('a card that moves between rows', () => {
  it('writes the band it landed in and keeps the column it was in', () => {
    const { onUpdateData } = mountKanban(bandedData())
    pressShiftArrow('a1', 'ArrowDown')
    expect(writtenCard(onUpdateData, 'a1')?.properties).toEqual({ status: TODO, owner: 'bob' })
  })

  it('says which row the card is now in', () => {
    const { container, onUpdateData } = mountKanban(bandedData())
    pressShiftArrow('a1', 'ArrowDown')
    expect(lastCommit(onUpdateData)).toBeTruthy()
    expect(liveRegion(container).textContent).toBe(t('preview.kanban_moved_to_band', {
      title: 'Card a1',
      group: formatKanbanGroupLabel(TODO, 'To Do'),
      band: bandLabel('bob', 'Bob'),
    }))
  })

  it('takes the card out of the field when it walks into the unassigned row', () => {
    const { onUpdateData } = mountKanban(bandedData())
    pressShiftArrow('a1', 'ArrowUp')
    const moved = writtenCard(onUpdateData, 'a1')
    expect('owner' in moved!.properties).toBe(false)
    expect(moved!.properties.status).toBe(TODO)
  })

  it('keeps the row it stands in when it walks to another column', () => {
    const { onUpdateData } = mountKanban(bandedData())
    pressShiftArrow('a1', 'ArrowRight')
    expect(writtenCard(onUpdateData, 'a1')?.properties).toEqual({ status: DOING, owner: 'alice' })
  })

  it('has nowhere to go at the edge of the grid and writes nothing', () => {
    const { onUpdateData } = mountKanban(bandedData())
    pressShiftArrow('n1', 'ArrowUp')
    pressShiftArrow('d1', 'ArrowRight')
    expect(lastCommit(onUpdateData)).toBeUndefined()
  })
})

/**
 * A long press, which is what a touch reader has instead of a drag: the browser reports it as a
 * contextmenu on the card. The menu is a portal, so its rows are read off the document.
 */
function longPressCard(itemId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  expect(card, `card ${itemId} is not in the document`).not.toBeNull()
  act(() => {
    card!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  })
}

function menuRow(label: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
    .find((button) => button.textContent === label)
  expect(row, `no pressed-open menu row labelled ${label}`).not.toBeNull()
  return row!
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('moving a card to another group from the menu a long press opens', () => {
  it('sends it to the group and keeps the row it was drawn in', () => {
    const { onUpdateData } = mountKanban(bandedData())
    longPressCard('a1')
    click(menuRow(t('preview.kanban_move_to_column')))
    click(menuRow('In Progress'))
    expect(writtenCard(onUpdateData, 'a1')?.properties).toEqual({ status: DOING, owner: 'alice' })
  })

  it('leaves the row it stood in when the group it moves to already holds a card of that row', () => {
    // Bob's row already holds a card of the target group, so a move that fell back to reordering by
    // group alone would draw this card beside that one and lose the row it never left.
    const data = bandedData()
    data.items.push(card('b2', { status: DOING, owner: 'bob' }))
    const { container, onUpdateData } = mountKanban(data)
    longPressCard('a1')
    click(menuRow(t('preview.kanban_move_to_column')))
    click(menuRow('In Progress'))
    expect(writtenCard(onUpdateData, 'a1')?.properties).toEqual({ status: DOING, owner: 'alice' })
    expect(cardIdsIn(cell(container, DOING, 'alice'))).toContain('a1')
    expect(cardIdsIn(cell(container, DOING, 'bob'))).not.toContain('a1')
  })

  it('marks the group the card is in, so the menu says where it already stands', () => {
    mountKanban(bandedData())
    longPressCard('d1')
    click(menuRow(t('preview.kanban_move_to_column')))
    expect(menuRow('In Progress').getAttribute('aria-checked')).toBe('true')
    expect(menuRow('To Do').getAttribute('aria-checked')).toBe('false')
  })

  it('spends no step of undo on the group the card already stands in', () => {
    const { onUpdateData } = mountKanban(bandedData())
    longPressCard('a1')
    click(menuRow(t('preview.kanban_move_to_column')))
    click(menuRow('To Do'))
    expect(lastCommit(onUpdateData)).toBeUndefined()
  })
})

describe('moving a card to another row from the menu a long press opens', () => {
  it('sends it to the row and keeps the column it was in', () => {
    const { onUpdateData } = mountKanban(bandedData())
    longPressCard('a1')
    click(menuRow(t('preview.kanban_move_to_band')))
    click(menuRow('Bob'))
    expect(writtenCard(onUpdateData, 'a1')?.properties).toEqual({ status: TODO, owner: 'bob' })
  })

  it('offers no row where the board draws no band', () => {
    mountKanban(bandedData({ swimlaneBy: undefined }))
    longPressCard('a1')
    expect(menuRow(t('preview.kanban_move_to_column'))).toBeTruthy()
    expect(
      [...document.querySelectorAll<HTMLElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
        .map((button) => button.textContent),
    ).not.toContain(t('preview.kanban_move_to_band'))
  })
})

describe('a card that lands in a column already past its rule', () => {
  it('says the row and the limit the column is now over', () => {
    const data = bandedData()
    data.columns[1] = {
      ...statusColumn,
      options: [
        { id: TODO, label: 'To Do', color: 'gray', wipLimit: 2 },
        { id: DOING, label: 'In Progress', color: 'blue' },
      ],
    }
    const { container } = mountKanban(data)
    pressShiftArrow('a1', 'ArrowDown')
    expect(liveRegion(container).textContent).toBe(t('preview.kanban_moved_to_band_over', {
      title: 'Card a1',
      group: formatKanbanGroupLabel(TODO, 'To Do'),
      band: bandLabel('bob', 'Bob'),
      over: 3,
      limit: 2,
    }))
  })
})

describe('turning the rows on and off from the board itself', () => {
  it('offers only the fields that can name a row', () => {
    const data = bandedData({ swimlaneBy: undefined })
    data.columns = [...data.columns, { id: 'notes', name: 'Notes', type: 'text' } as KanbanProperty]
    const { container } = mountKanban(data)
    const select = swimlaneSelect(openViewOptions(container))
    // The off option, plus Owner: never the title, and never the field the columns already cut by.
    expect([...select.options].map((option) => option.value)).toEqual(['', 'owner'])
  })

  it('cuts the board into rows with the field a reader picks', () => {
    const { container, onUpdateData } = mountKanban(bandedData({ swimlaneBy: undefined }))
    choose(swimlaneSelect(openViewOptions(container)), 'owner')
    expect(rows(container)).toEqual([UNASSIGNED, 'alice', 'bob'])
    expect(committedView(onUpdateData)?.swimlaneBy).toBe('owner')
  })

  it('puts the board back to one row when the reader picks none', () => {
    const { container, onUpdateData } = mountKanban(bandedData())
    choose(swimlaneSelect(openViewOptions(container)), '')
    expect(rows(container)).toEqual([])
    expect(committedView(onUpdateData)?.swimlaneBy).toBeUndefined()
  })

  it('keeps naming a field that stopped qualifying, because the board is still banded by it', () => {
    const data = bandedData()
    // The field lost the list of values it used to cut rows by, so it no longer offers candidates —
    // but the rows on screen are still drawn off it, and a reader must be able to see which one.
    data.columns = data.columns.map((column) => (column.id === 'owner' ? { ...column, options: [] } : column))
    const { container } = mountKanban(data)
    expect(rows(container)).toEqual([UNASSIGNED])
    const select = swimlaneSelect(openViewOptions(container))
    expect([...select.options].map((option) => option.value)).toEqual(['', 'owner'])
    expect(select.value).toBe('owner')
  })
})

describe('what a banded column still answers to', () => {
  it('offers no collapse where there is no narrower form of the column', () => {
    const { container } = mountKanban(bandedData())
    const dialog = openStripMenu(container, TODO)
    expect([...dialog.querySelectorAll('button')].map((button) => button.textContent)).not.toContain(
      t('preview.kanban_collapse_column'),
    )
  })

  it('still collapses a column of an unbanded board', () => {
    const { container } = mountKanban(bandedData({ swimlaneBy: undefined }))
    const todo = container.querySelector<HTMLElement>(`[data-kanban-group="${TODO}"]`)
    const trigger = todo!.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
    act(() => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect([...dialog!.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      t('preview.kanban_collapse_column'),
    )
  })
})
