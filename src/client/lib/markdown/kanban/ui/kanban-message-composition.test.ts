/**
 * Half a dozen kanban labels were assembled in JSX out of message fragments — `${action}: ${name}`,
 * `{label} {count} {noun}`, `{label} ({count})` — which freezes English word order into the
 * component: a Chinese reader of the same board hears an ASCII colon inside a Chinese phrase, and a
 * single selected card reads "Selected 1 items". Each case asserts the whole phrase comes from one
 * resource entry with only the value substituted, in both languages the app ships.
 */
import { act, createElement, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { KanbanItem, KanbanProperty, KanbanView } from '../types'
import { KanbanBatchBar } from './kanban-batch-bar'
import { buildKanbanContextMenuItems, type KanbanContextMenuProps } from './kanban-context-menu'
import { CollapsedColumn } from './kanban-column-header'
import {
  installBilingualLabelHooks,
  inLocale,
  LOCALES,
  type LocaleCode,
  messageIn,
  mountIn,
} from './kanban-bilingual-labels.test-helpers'
import { KanbanTableGroup } from './kanban-table-group'

installBilingualLabelHooks()

const titleColumn = { id: 'title', name: 'Title', type: 'title' } as KanbanProperty
const statusColumn = { id: 'status', name: 'Status', type: 'select' } as KanbanProperty
const itemWithSubtask: KanbanItem = {
  id: 'a',
  title: 'Design spec',
  subtasks: [{ id: 's1', title: 'Draft the outline', completed: false }],
  properties: { status: 'todo' },
}

describe('the batch bar counts its selection', () => {
  function bar(container: HTMLElement): string {
    return container.querySelector('span')?.textContent ?? ''
  }

  function mountBar(code: LocaleCode, selectedCount: number): Promise<HTMLElement> {
    return mountIn(code, createElement(KanbanBatchBar, {
      selectedCount,
      onBatchGroupChange: vi.fn(),
      onBatchArchive: vi.fn(),
      onBatchDelete: vi.fn(),
      onClearSelection: vi.fn(),
    }))
  }

  it.each(LOCALES)('says the whole count phrase in one message in %s', async (code) => {
    expect(bar(await mountBar(code, 3))).toBe(
      messageIn(code, 'preview.kanban_batch_selected_count', { count: 3 }),
    )
  })

  it('does not call one selection a plural', async () => {
    expect(bar(await mountBar('en-US', 1))).toBe(
      messageIn('en-US', 'preview.kanban_batch_selected_count', { count: 1 }),
    )
  })
})

describe('a collapsed column names its group', () => {
  it.each(LOCALES)('keeps the group inside the message in %s', async (code) => {
    const container = await mountIn(code, createElement(CollapsedColumn, {
      group: { groupKey: 'backlog', label: 'Backlog', items: [] },
      onExpand: vi.fn(),
      onDrop: vi.fn(),
      onDragOver: vi.fn(),
      isDragOver: false,
    }))
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_expand_column_named', { name: 'Backlog' }),
    )
  })
})

/**
 * The group's collapse state belongs to whoever draws the group (the board's view memory, in the app),
 * so the harness holds it the way that owner does: one state pair, forwarded down.
 */
function HarnessTableGroup(props: Omit<Parameters<typeof KanbanTableGroup>[0], 'collapsed' | 'onToggleCollapse'>) {
  const [collapsed, setCollapsed] = useState(false)
  return createElement(KanbanTableGroup, { ...props, collapsed, onToggleCollapse: () => setCollapsed((c) => !c) })
}

async function mountTableGroup(code: LocaleCode): Promise<HTMLElement> {
  return mountIn(code, createElement(HarnessTableGroup, {
    groupKey: 'backlog',
    label: 'Backlog',
    items: [itemWithSubtask],
    columns: [titleColumn, statusColumn],
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onOpenDetail: vi.fn(),
    onUpdateProperty: vi.fn(),
    onUpdateMultiSelect: vi.fn(),
    onUpdateSubtasks: vi.fn(),
    onUpdateFiles: vi.fn(),
    onAddItemInGroup: vi.fn(),
  }))
}

function groupToggle(container: HTMLElement): HTMLElement {
  const toggle = container.querySelector<HTMLElement>('[role="row"] button[aria-expanded]')
  if (!toggle) throw new Error('the group header renders no control that names its collapse state')
  return toggle
}

describe('the table group toggle', () => {
  it.each(LOCALES)('names both states with the group inside the message in %s', async (code) => {
    const container = await mountTableGroup(code)
    expect(groupToggle(container).getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_collapse_group_named', { name: 'Backlog' }),
    )
    act(() => {
      groupToggle(container).click()
    })
    expect(groupToggle(container).getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_expand_group_named', { name: 'Backlog' }),
    )
  })
})

async function openSubtasks(code: LocaleCode): Promise<HTMLElement> {
  const container = await mountTableGroup(code)
  const expander = container.querySelector<HTMLElement>('[role="rowheader"] button[aria-expanded="false"]')
  if (!expander) throw new Error('the row gives its subtask panel no control')
  act(() => {
    expander.click()
  })
  return container
}

describe('the subtask rows of a table group', () => {
  it.each(LOCALES)('counts them in one message in %s', async (code) => {
    const container = await openSubtasks(code)
    const cell = container.querySelector<HTMLElement>('form')?.closest<HTMLElement>('[role="cell"]')
    expect(cell, 'the add-subtask form sits outside the subtask panel').not.toBeNull()
    const heading = cell!.querySelector(':scope > div')
    expect(heading?.textContent).toBe(
      messageIn(code, 'preview.kanban_subtasks_count', { count: 1 }),
    )
  })

  it.each(LOCALES)('names the delete row with the subtask inside the message in %s', async (code) => {
    const container = await openSubtasks(code)
    const del = container.querySelector<HTMLElement>('button[aria-label*="Draft the outline"]')
    expect(del, 'no delete control names the subtask').not.toBeNull()
    expect(del!.getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_delete_named', { name: 'Draft the outline' }),
    )
  })
})

describe('the context menu deletes a selection', () => {
  const views: KanbanView[] = [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }]

  function batchDeleteLabel(selectedCount: number): string | undefined {
    const props = {
      point: { x: 10, y: 10 },
      targetItem: null,
      selectedCount,
      activeView: views[0]!,
      views,
      onClose: vi.fn(),
      onAddItem: vi.fn(),
      onBatchDelete: vi.fn(),
    } as KanbanContextMenuProps
    return buildKanbanContextMenuItems(props).find((item) => item.id === 'kanban-batch-delete')?.label
  }

  it.each(LOCALES)('puts the count inside the message in %s', async (code) => {
    await inLocale(code)
    expect(batchDeleteLabel(2)).toBe(
      messageIn(code, 'preview.kanban_batch_delete_count', { count: 2 }),
    )
  })
})
