/**
 * Which columns a board prints on its cards, asked of the header that offers them.
 *
 * The panel is one of the two doors onto `cardFields` (the view options), so what is asserted here is
 * the wiring rather than the rules: the list names the board's own columns, the title is not one of
 * them (it is the card's heading), a checked box reads the view's stored list, and a press reaches the
 * writer with the column id. The table is the negative case beside it — it draws every column already,
 * so it is offered no card fields at all.
 *
 * These live apart from `kanban-header.test.ts` because that file is at the size AGENTS.md allows and
 * this section would take it past it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { formatKanbanPropertyName } from '../i18n-helpers'
import { KanbanHeader } from './kanban-header'
import type { KanbanSchemaOperations } from './kanban-column-hooks'
import type { KanbanData, KanbanItem, KanbanProperty } from '../types'

beforeAll(async () => {
  await initI18n()
})

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'done', label: 'Done', color: 'green' },
    { id: 'todo', label: 'To Do', color: 'gray' },
  ],
}

const boardColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  statusColumn,
  { id: 'estimate', name: 'Estimate', type: 'number' },
]

const tableColumns: KanbanProperty[] = [
  { id: 'title', name: 'Title', type: 'title' },
  statusColumn,
  { id: 'spec', name: 'Spec file', type: 'text' },
]

const items: KanbanItem[] = [
  { id: 'a', title: 'a', properties: { status: 'done' } },
  { id: 'b', title: 'b', properties: { status: 'todo' } },
]

/** The switcher's own contract is covered in kanban-view-tabs.test.ts; here it only has to exist. */
function stubViewOps(): ComponentProps<typeof KanbanHeader>['viewOps'] {
  return {
    createView: vi.fn(),
    renameView: vi.fn(),
    duplicateView: vi.fn(),
    deleteView: vi.fn(),
    moveView: vi.fn(),
  }
}

function stubSchemaOps(): KanbanSchemaOperations {
  return {
    addColumn: vi.fn(),
    renameColumn: vi.fn(),
    changeColumnType: vi.fn(),
    deleteColumn: vi.fn(),
    moveColumn: vi.fn(),
    resizeColumn: vi.fn(),
  }
}

function renderHeader(data: KanbanData, extra: Partial<ComponentProps<typeof KanbanHeader>>) {
  return renderElement(
    createElement(KanbanHeader, {
      data,
      visibleItems: items,
      activeView: data.views[0]!,
      searchQuery: '',
      filters: [],
      sorts: [],
      onSelectView: vi.fn(),
      onSearchChange: vi.fn(),
      onChangeFilters: vi.fn(),
      onChangeSorts: vi.fn(),
      onAddItem: vi.fn(),
      viewOps: stubViewOps(),
      viewPanelId: 'view-panel',
      ...extra,
    }),
  )
}

/**
 * A board header, which is the only surface offered card fields. The view options trigger needs the
 * writers a board wires (grouping and card size) before it draws at all.
 */
function renderBoardHeader(cardFields: string[], onToggleCardField = vi.fn()) {
  const data: KanbanData = {
    columns: boardColumns,
    items,
    views: [{ id: 'vb', name: 'Board', type: 'board', groupBy: 'status', cardFields }],
  }
  const rendered = renderHeader(data, {
    cardSize: 'medium',
    onChangeCardSize: vi.fn(),
    onChangeGroupBy: vi.fn(),
    onToggleCardField,
  })
  return { ...rendered, onToggleCardField }
}

function renderTableHeader(hiddenColumns: string[]) {
  const data: KanbanData = {
    columns: tableColumns,
    items,
    views: [{ id: 'vt', name: 'Table', type: 'table', groupBy: 'status', hiddenColumns }],
  }
  return renderHeader(data, { onToggleHiddenColumn: vi.fn(), schemaOps: stubSchemaOps() })
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(name))
  if (!button) throw new Error(`no button labelled "${name}"`)
  return button
}

function columnName(id: string): string {
  const column = [...boardColumns, ...tableColumns].find((col) => col.id === id)
  if (!column) throw new Error(`no fixture column "${id}"`)
  return formatKanbanPropertyName(column)
}

/** A column's checkbox in the card-fields list, found by the name the column carries. */
function fieldToggle(panel: HTMLElement, name: string): HTMLInputElement | null {
  const list = panel.querySelector<HTMLElement>('[data-kanban-card-field-list]')
  if (!list) throw new Error('the view options panel drew no card field list')
  const label = [...list.querySelectorAll('label')].find((el) => el.textContent?.includes(name))
  return label?.querySelector('input[type="checkbox"]') ?? null
}

describe('the board panel offers the columns a card prints', () => {
  it('lists them, leaves the title out, and reports the one being toggled', () => {
    const { container, unmount, onToggleCardField } = renderBoardHeader(['estimate'])
    try {
      act(() => { buttonNamed(container, t('preview.kanban_group_by')).click() })
      const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(fieldToggle(panel, columnName('title'))).toBeNull()
      expect(fieldToggle(panel, columnName('estimate'))?.checked).toBe(true)
      expect(fieldToggle(panel, columnName('status'))?.checked).toBe(false)
      act(() => { fieldToggle(panel, columnName('status'))!.click() })
      expect(onToggleCardField).toHaveBeenCalledWith('status')
    } finally {
      unmount()
    }
  })

  it('draws the list before a reader has picked anything', () => {
    const { container, unmount } = renderBoardHeader([])
    try {
      act(() => { buttonNamed(container, t('preview.kanban_group_by')).click() })
      const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(fieldToggle(panel, columnName('status'))?.checked).toBe(false)
    } finally {
      unmount()
    }
  })
})

describe('the table panel offers no card fields', () => {
  it('draws no field list for a view that already shows every column', () => {
    const { container, unmount } = renderTableHeader([])
    try {
      act(() => { buttonNamed(container, t('preview.kanban_columns')).click() })
      const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect(panel.querySelector('[data-kanban-card-field-list]')).toBeNull()
      expect(panel.textContent).toContain(t('preview.kanban_columns'))
    } finally {
      unmount()
    }
  })
})
