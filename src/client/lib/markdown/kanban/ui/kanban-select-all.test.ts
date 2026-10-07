/**
 * Picking many cards at once is what the batch bar exists for, and neither the board nor the list
 * could do it — a reader who wanted to reassign twenty cards had to tick twenty checkboxes. Two ways
 * in are pinned here: the column menu's own select-all, and the menu a right click or a long press
 * opens, whose "every card the view draws" is however many the filter and the search leave standing.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData } from '../types'
import { KanbanRoot } from './kanban-root'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'
const DOING = 'doing'

function boardData(over: Partial<KanbanData['views'][number]> = {}): KanbanData {
  return {
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: TODO, label: 'To Do', color: 'gray' },
          { id: DOING, label: 'Doing', color: 'blue' },
        ],
      },
    ],
    items: [
      { id: 'a', title: 'Design spec', properties: { status: TODO } },
      { id: 'b', title: 'Design tokens', properties: { status: TODO } },
      { id: 'c', title: 'Ship it', properties: { status: DOING } },
    ],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status', ...over }],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(data: KanbanData) {
  const onUpdateData = vi.fn()
  const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
  mounted.push(rendered)
  return { ...rendered, onUpdateData }
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function column(container: HTMLElement, groupKey: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-kanban-group="${groupKey}"]`)
  expect(node, `the board draws no column ${groupKey}`).not.toBeNull()
  return node!
}

/** The header's own menu trigger: the only dialog opener inside a column of a plain board. */
function columnMenuTrigger(container: HTMLElement, groupKey: string): HTMLElement {
  const trigger = column(container, groupKey).querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
  expect(trigger, `column ${groupKey} offers no menu`).not.toBeNull()
  return trigger!
}

/** The trigger is a toggle, so a menu left open by an earlier step is closed before opening again. */
function openColumnMenu(container: HTMLElement, groupKey: string): HTMLElement {
  if (document.querySelector('[role="dialog"]')) click(columnMenuTrigger(container, groupKey))
  click(columnMenuTrigger(container, groupKey))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog, 'the column menu did not open').not.toBeNull()
  return dialog!
}

function columnSelectAllBox(dialog: HTMLElement): HTMLInputElement {
  const box = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(box, 'the column menu offers no select-all control').not.toBeNull()
  return box!
}

function openSelectAll(container: HTMLElement, groupKey: string): void {
  const dialog = openColumnMenu(container, groupKey)
  expect(dialog.textContent).toContain(t('preview.kanban_select_group'))
  click(columnSelectAllBox(dialog))
}

/** A right click or a long press on the board itself, which is not a card: the view's own menu. */
function openCanvasMenu(container: HTMLElement): HTMLElement[] {
  const board = container.firstElementChild
  expect(board, 'the board mounted nothing to press on').not.toBeNull()
  act(() => {
    board!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
  })
  return [...document.querySelectorAll<HTMLElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
}

function menuRow(rows: HTMLElement[], label: string): HTMLElement {
  const row = rows.find((button) => button.textContent === label)
  expect(row, `no menu row labelled ${label} among ${rows.map((r) => r.textContent).join(' / ')}`).toBeDefined()
  return row!
}

function selectedIds(container: HTMLElement): string[] {
  const picked = [...container.querySelectorAll<HTMLElement>('[data-item-id]')]
    .filter((card) => card.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked)
    .map((card) => card.dataset.itemId!)
  return [...new Set(picked)].sort()
}

function batchBar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-kanban-batch-archive]')?.closest('div') ?? null
}

describe('selecting a whole column from its menu', () => {
  it('ticks every card of that column and reports them in the batch bar', () => {
    const { container } = mountBoard(boardData())
    openSelectAll(container, TODO)
    expect(selectedIds(container)).toEqual(['a', 'b'])
    expect(container.textContent).toContain(t('preview.kanban_batch_selected_count', { count: 2 }))
  })

  it('leaves the other columns alone', () => {
    const { container } = mountBoard(boardData())
    openSelectAll(container, DOING)
    expect(selectedIds(container)).toEqual(['c'])
  })

  it('is a control that shows whether the column is already picked, and clears it when unticked', () => {
    const { container } = mountBoard(boardData())
    expect(columnSelectAllBox(openColumnMenu(container, TODO)).checked).toBe(false)
    openSelectAll(container, TODO)
    expect(selectedIds(container)).toEqual(['a', 'b'])
    expect(columnSelectAllBox(openColumnMenu(container, TODO)).checked).toBe(true)
    openSelectAll(container, TODO)
    expect(selectedIds(container)).toEqual([])
    expect(batchBar(container)).toBeNull()
  })
})

describe('selecting every card the view draws', () => {
  it('picks the visible cards and not the ones a search has filtered out', () => {
    const { container } = mountBoard(boardData({ searchQuery: 'Design' }))
    click(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')))
    expect(selectedIds(container)).toEqual(['a', 'b'])
    // The count is what tells the two readings apart: a filtered-out card is not drawn, so only the
    // bar can say whether the pick also took the cards the search hid.
    expect(container.textContent).toContain(t('preview.kanban_batch_selected_count', { count: 2 }))
  })

  it('says it is already done once every visible card is picked', () => {
    const { container } = mountBoard(boardData())
    click(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')))
    expect(selectedIds(container)).toEqual(['a', 'b', 'c'])
    expect(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')).getAttribute('aria-checked')).toBe('true')
  })

  it('clears the selection again when every visible card was already picked', () => {
    const { container } = mountBoard(boardData())
    click(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')))
    click(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')))
    expect(selectedIds(container)).toEqual([])
  })

  it('reaches the list view too, where there is no column to select', () => {
    const { container } = mountBoard(boardData({ type: 'list' }))
    click(menuRow(openCanvasMenu(container), t('preview.kanban_select_all_visible')))
    expect(selectedIds(container)).toEqual(['a', 'b', 'c'])
  })
})
