/**
 * The board's table view is laid out with flex containers, so the markup gives no
 * clue that a value belongs to a column: a reader walks a row as one
 * undifferentiated run of controls (review #29). The roles asserted here are the
 * ones that relationship needs — and a row that spans the grid has to say how many
 * columns it covers, otherwise the column count a reader announces stops matching
 * the header, including after a column is hidden.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { formatKanbanPropertyName } from '../i18n-helpers'
import type { KanbanData, KanbanProperty } from '../types'
import { KanbanTableView } from './kanban-table-view'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const titleColumn = { id: 'title', name: 'Title', type: 'title' } as KanbanProperty
const statusColumn = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'doing', label: 'In Progress', color: 'blue' },
  ],
} as KanbanProperty
const specColumn = { id: 'spec', name: 'Spec file', type: 'text' } as KanbanProperty

const data: KanbanData = {
  columns: [titleColumn, statusColumn, specColumn],
  items: [
    {
      id: 'a',
      title: 'Design spec',
      subtasks: [{ id: 's1', title: 'Draft the outline', completed: false }],
      properties: { status: 'todo', spec: 'docs/a.md' },
    },
    { id: 'b', title: 'Empty ticket', properties: { status: 'doing' } },
  ],
  views: [{ id: 'v', name: 'Table', type: 'table', groupBy: 'status' }],
}

// selection column + title + status + spec + the appended attachments column
const COLUMN_COUNT = 5

const mounted: ReturnType<typeof renderElement>[] = []

function mount(overrides: Partial<{ hiddenColumns: string[] }> = {}) {
  const rendered = renderElement(createElement(KanbanTableView, {
    data,
    view: { ...data.views[0]!, hiddenColumns: overrides.hiddenColumns },
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onToggleAll: vi.fn(),
    onOpenDetail: vi.fn(),
    onUpdateProperty: vi.fn(),
    onUpdateMultiSelect: vi.fn(),
    onUpdateSubtasks: vi.fn(),
    onUpdateFiles: vi.fn(),
    onAddItem: vi.fn(),
    onAddColumn: vi.fn(),
    people: {},
    onSortColumn: vi.fn(),
  }))
  mounted.push(rendered)
  return rendered.container
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function rows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="row"]')]
}

function headerCells(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="columnheader"]')]
}

/** The cells a row is made of, in visual order. */
function cellsOf(row: HTMLElement): HTMLElement[] {
  return [...row.children] as HTMLElement[]
}

function ownerRole(el: HTMLElement): string | null {
  let node: Element | null = el.parentElement
  while (node && node.getAttribute('role') === 'presentation') node = node.parentElement
  return node?.getAttribute('role') ?? null
}

function text(el: Element | null | undefined): string {
  return el?.textContent ?? ''
}

function buttonByText(root: ParentNode, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find((el) => text(el).includes(label))
  if (!button) throw new Error(`no button labelled "${label}"`)
  return button
}

/** The chevron that opens an item's subtask panel; it has no accessible name yet. */
function subtaskToggle(rowheader: HTMLElement): HTMLButtonElement {
  const button = rowheader.querySelector<HTMLButtonElement>('button')
  if (!button) throw new Error('no control to open the subtask panel')
  return button
}

function itemRowheader(container: ParentNode, itemId: string): HTMLElement {
  const cell = container.querySelector<HTMLElement>(`[data-item-id="${itemId}"] [role="rowheader"]`)
  if (!cell) throw new Error(`item "${itemId}" has no row header naming it`)
  return cell
}

describe('table structure', () => {
  it('names the grid itself instead of wrapping it in a region', () => {
    const container = mount()
    const table = container.querySelector<HTMLElement>('[role="table"]')

    expect(table, 'the grid is still an anonymous pile of boxes').not.toBeNull()
    expect(table?.getAttribute('aria-label'), 'the grid carries no name of its own').toBe(t('preview.kanban_view_table'))
    expect(container.querySelector('[role="region"]'), 'the view names itself a second time around the grid').toBeNull()
  })

  it('names every column in a header row', () => {
    const container = mount()
    const headerRow = rows(container)[0]
    const [selectAll, ...namedColumns] = headerCells(container)

    expect(headerRow, 'the header line is not a row').not.toBeUndefined()
    expect(headerCells(container).length, 'the header skips a column').toBe(COLUMN_COUNT)
    expect(selectAll?.parentElement).toBe(headerRow)
    expect(selectAll?.querySelector('input')?.getAttribute('aria-label')).toBe(t('preview.kanban_select_all'))
    expect(namedColumns.map(text)).toEqual([
      formatKanbanPropertyName(titleColumn),
      formatKanbanPropertyName(statusColumn),
      formatKanbanPropertyName(specColumn),
      t('preview.kanban_files'),
    ])
  })

  it('reads an item row as cells in the same columns as the header', () => {
    const container = mount()
    const rowheader = itemRowheader(container, 'a')
    const itemRow = rowheader.parentElement!

    expect(rowheader.textContent).toContain('Design spec')
    expect(itemRow.getAttribute('role'), 'the item line is not a row').toBe('row')
    expect(cellsOf(itemRow).map((cell) => cell.getAttribute('role'))).toEqual([
      'cell',
      'rowheader',
      'cell',
      'cell',
      'cell',
    ])
  })
})

describe('rows and cells', () => {
  it('keeps every row and cell inside the table', () => {
    const container = mount()

    for (const row of rows(container)) {
      expect(ownerRole(row), `a row sits under role=${ownerRole(row)}`).toMatch(/^(table|rowgroup)$/)
    }
    for (const cell of container.querySelectorAll<HTMLElement>('[role="cell"], [role="columnheader"], [role="rowheader"]')) {
      expect(cell.parentElement?.getAttribute('role'), `a ${cell.getAttribute('role')} is not in a row`).toBe('row')
    }
  })

  // A `select` announces its current option and nothing else, so an unnamed one in a grid is read as
  // "To Do" with no hint of which column that value belongs to — the axe pass over the real overlay
  // reported `select-name` for every one of them. The text and checkbox editors in the same cell
  // already name themselves after their column; a dropdown has to do the same.
  it('names each value editor after the column it writes', () => {
    const container = mount()
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')]

    expect(selects.length, 'the grid offers no dropdown to name').toBeGreaterThan(0)
    for (const select of selects) {
      expect(select.getAttribute('aria-label'), 'a dropdown is announced by its value alone').toBe(
        formatKanbanPropertyName(statusColumn),
      )
    }
  })
})

describe('grouped rows', () => {
  function groupRoot(container: ParentNode): HTMLElement {
    const group = container.querySelector<HTMLElement>('[role="rowgroup"]')
    if (!group) throw new Error('a group of rows is not a rowgroup')
    return group
  }

  it('groups each group under a rowgroup of the table', () => {
    const container = mount()
    const group = groupRoot(container)

    expect(group.querySelector('[data-item-id="a"]'), 'the group does not hold its own rows').not.toBeNull()
    expect(group.querySelector('[data-item-id="b"]'), 'both groups collapsed into one').toBeNull()
    expect(ownerRole(group), 'the rowgroup escaped the table').toBe('table')
  })

  it('says the group heading and footer span the whole row', () => {
    const container = mount()
    const group = groupRoot(container)
    const spanning = [...group.querySelectorAll<HTMLElement>('[aria-colspan]')]

    expect(spanning.length, 'nothing says how wide the group rows are').toBeGreaterThanOrEqual(2)
    for (const cell of spanning) {
      expect(cell.getAttribute('aria-colspan'), 'a spanning row miscounts the columns').toBe(String(COLUMN_COUNT))
    }
    expect(group.contains(rows(container)[0]), 'the header row belongs to a group').toBe(false)
  })

  it('recounts the span when a column is hidden', () => {
    const container = mount({ hiddenColumns: ['spec'] })

    expect(headerCells(container).length, 'hiding a column left its header behind').toBe(COLUMN_COUNT - 1)
    for (const cell of container.querySelectorAll<HTMLElement>('[aria-colspan]')) {
      expect(cell.getAttribute('aria-colspan'), 'a spanning row still claims the hidden column').toBe(String(COLUMN_COUNT - 1))
    }
  })

  it('keeps the add-group action a row of the table rather than loose content', () => {
    const container = mount()
    const button = buttonByText(container, t('preview.kanban_add_new_group'))
    const cell = button.closest<HTMLElement>('[role="cell"]')

    expect(cell, 'the action floats outside the row structure').not.toBeNull()
    expect(cell!.getAttribute('aria-colspan'), 'the action row does not span the grid').toBe(String(COLUMN_COUNT))
    expect(cell!.parentElement?.getAttribute('role')).toBe('row')
    expect(ownerRole(cell!.parentElement!), 'the action row is not part of the table').toBe('table')
  })
})

describe('expanded subtasks', () => {
  it('announces the subtask panel as a row spanning the columns', () => {
    const container = mount()
    act(() => { subtaskToggle(itemRowheader(container, 'a')).click() })

    const panel = container.querySelector<HTMLElement>('[data-item-id="a"] [role="cell"][aria-colspan]')
    expect(panel, 'the expanded panel is not a cell of the table').not.toBeNull()
    expect(panel!.getAttribute('aria-colspan'), 'the panel does not span the grid').toBe(String(COLUMN_COUNT))
    expect(panel!.parentElement?.getAttribute('role')).toBe('row')
    expect(text(panel)).toContain('Draft the outline')
  })
})
