import { act, createElement, type ReactNode } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { useKanbanAddOperations } from './kanban-root-hooks'
import { KanbanCalendarView } from './kanban-calendar-view'
import type { KanbanData, KanbanItem, KanbanView } from '../types'

beforeAll(async () => {
  await initI18n()
})

const statusColumn = {
  id: 'status',
  name: 'Status',
  type: 'select' as const,
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' as const },
    { id: 'doing', label: 'Doing', color: 'blue' as const },
  ],
}

const priorityColumn = {
  id: 'priority',
  name: 'Priority',
  type: 'select' as const,
  options: [
    { id: 'high', label: 'High', color: 'red' as const },
    { id: 'low', label: 'Low', color: 'gray' as const },
  ],
}

const assigneeColumn = { id: 'assignee', name: 'Assignee', type: 'text' as const }

function makeData(overrides: Partial<KanbanData> = {}): KanbanData {
  return {
    columns: [statusColumn, priorityColumn, assigneeColumn],
    items: [],
    views: [{ id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' }],
    ...overrides,
  }
}

type AddApi = ReturnType<typeof useKanbanAddOperations>

function renderAddHook(
  data: KanbanData,
  activeView: KanbanView,
  commitData: (next: KanbanData) => void,
  setDetailItem: (item: KanbanItem | null) => void = vi.fn(),
): AddApi {
  let api: AddApi | null = null
  function Probe() {
    api = useKanbanAddOperations(data, commitData, setDetailItem, activeView)
    return null
  }
  const rendered = renderElement(createElement(Probe))
  rendered.unmount()
  if (!api) throw new Error('probe did not expose the hook api')
  return api
}

function captureCommit(data: KanbanData, activeView: KanbanView) {
  const commits: KanbanData[] = []
  const opened: KanbanItem[] = []
  const api = renderAddHook(data, activeView, (d) => {
    commits.push(d)
  }, (item) => {
    if (item) opened.push(item)
  })
  const addedItem = () => commits[0]!.items[0]!
  return { api, addedItem, commits, opened }
}

describe('useKanbanAddOperations', () => {
  it('handleAddItem with a date record writes the date field and keeps the default status', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Calendar', type: 'calendar' })
    api.handleAddItem({ startDate: '2026-09-18' })
    expect(addedItem().properties.startDate).toBe('2026-09-18')
    expect(addedItem().properties.status).toBe('todo')
  })

  it('handleAddItem with no defaults still gets the first status option', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'status' })
    api.handleAddItem()
    expect(addedItem().properties.status).toBe('todo')
  })

  it('a board whose status column is named anything else still lands the card in its first option', () => {
    const custom: KanbanData = {
      columns: [
        { id: 'title', name: 'Title', type: 'title' },
        { id: 'state', name: 'State', type: 'select', options: [{ id: 'open', label: 'Open', color: 'blue' }] },
      ],
      items: [],
      views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'state' }],
    }
    const { api, addedItem } = captureCommit(custom, custom.views[0]!)
    api.handleAddItem()
    expect(addedItem().properties.state).toBe('open')
    expect(addedItem().properties).not.toHaveProperty('status')
  })

  it('a board with no option column at all writes no ghost status', () => {
    const bare: KanbanData = {
      columns: [{ id: 'title', name: 'Title', type: 'title' }],
      items: [],
      views: [{ id: 'v', name: 'Board', type: 'board' }],
    }
    const { api, addedItem } = captureCommit(bare, bare.views[0]!)
    api.handleAddItem()
    expect(addedItem().properties).not.toHaveProperty('status')
  })

  it('handleAddItemInGroup targets the active view groupBy property, not status', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'priority' })
    api.handleAddItemInGroup({ groupKey: 'high' })
    expect(addedItem().properties.priority).toBe('high')
    expect(addedItem().properties.status).toBe('todo')
  })

  it('handleAddItemInGroup with the no-group sentinel creates a plain default item', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'priority' })
    api.handleAddItemInGroup({ groupKey: '__none__' })
    expect(addedItem().properties.status).toBe('todo')
    expect(addedItem().properties.priority).toBeUndefined()
  })

  it('handleAddItemInGroup on a cell of a banded row writes that row into the lane field', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'priority', swimlaneBy: 'assignee' })
    api.handleAddItemInGroup({ groupKey: 'high', laneKey: 'bob' })
    expect(addedItem().properties.priority).toBe('high')
    expect(addedItem().properties.assignee).toBe('bob')
  })

  it('handleAddItemInGroup on the unassigned row leaves the lane field empty', () => {
    const { api, addedItem } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'priority', swimlaneBy: 'assignee' })
    api.handleAddItemInGroup({ groupKey: 'high', laneKey: '__none__' })
    expect(addedItem().properties.priority).toBe('high')
    expect(addedItem().properties.assignee).toBeUndefined()
  })
})

/**
 * A new card can arrive two ways: named by the reader, or named by the placeholder and handed to them in
 * its own window. The column's title field is the first (KU-13), every other door is the second, and the
 * difference between them is one optional argument rather than a second add path — two paths would be
 * two places to keep the group, the lane and the first status option in step.
 */
describe('how a new card finishes', () => {
  const view: KanbanView = { id: 'v', name: 'Board', type: 'board', groupBy: 'status' }

  it('names the card with the title it was handed instead of the placeholder', () => {
    const { api, addedItem, opened } = captureCommit(makeData(), view)
    api.handleAddItem(undefined, { title: '  Write the spec  ', openDetail: false })
    expect(addedItem().title).toBe('Write the spec')
    expect(opened).toHaveLength(0)
  })

  it('falls back to the placeholder when the title is blank, which is the door the header uses', () => {
    const { api, addedItem } = captureCommit(makeData(), view)
    api.handleAddItem(undefined, { title: '   ' })
    expect(addedItem().title).toBe(t('preview.kanban_new_task'))
  })

  it('opens the new card by default and holds it back when asked to', () => {
    const first = captureCommit(makeData(), view)
    first.api.handleAddItem()
    expect(first.opened[0]?.id).toBe(first.addedItem().id)

    const second = captureCommit(makeData(), view)
    second.api.handleAddItemInGroup({ groupKey: 'doing' }, { title: 'Typed', openDetail: false })
    expect(second.opened).toHaveLength(0)
    expect(second.addedItem().properties.status).toBe('doing')
    expect(second.addedItem().title).toBe('Typed')
  })
})

describe('useKanbanAddOperations handleAddColumn', () => {
  it('handleAddColumn adds the option to the view groupBy column, not status', () => {
    const { api, commits } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'priority' })
    act(() => { api.handleAddColumn() })
    const committed = commits[0]!
    const priority = committed.columns.find((c) => c.id === 'priority')!
    const status = committed.columns.find((c) => c.id === 'status')!
    expect(priority.options).toHaveLength(3)
    expect(status.options).toHaveLength(2)
    expect(priority.options![2]!.id.startsWith('priority-')).toBe(true)
    expect(priority.options![2]!.label).toBe(t('preview.kanban_new_group_title', { value0: 3 }))
  })

  it('handleAddColumn still targets status when the view declares no groupBy', () => {
    const { api, commits } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board' })
    act(() => { api.handleAddColumn() })
    const status = commits[0]!.columns.find((c) => c.id === 'status')!
    expect(status.options).toHaveLength(3)
  })

  it('handleAddColumn commits nothing when grouping by an option-less property', () => {
    const { api, commits } = captureCommit(makeData(), { id: 'v', name: 'Board', type: 'board', groupBy: 'assignee' })
    act(() => { api.handleAddColumn() })
    expect(commits).toHaveLength(0)
  })
})

function renderCalendar(onAddItem: (defaults?: Record<string, unknown>) => void) {
  const node: ReactNode = createElement(KanbanCalendarView, {
    data: makeData({ views: [{ id: 'v', name: 'Calendar', type: 'calendar' }] }),
    onOpenDetail: vi.fn(),
    onAddItem,
  })
  return renderElement(node)
}

describe('KanbanCalendarView add-from-day-cell', () => {
  it('passes the clicked day into the date field instead of a bare status string', () => {
    const onAddItem = vi.fn()
    const rendered = renderCalendar(onAddItem)
    const addButton = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="New item"]',
    )!
    expect(addButton).toBeTruthy()
    act(() => {
      addButton.click()
    })
    expect(onAddItem).toHaveBeenCalledTimes(1)
    const arg = onAddItem.mock.calls[0]![0]
    expect(typeof arg).toBe('object')
    expect(arg).toMatchObject({ startDate: /^\d{4}-\d{2}-\d{2}$/ })
    expect((arg as Record<string, unknown>).status).toBeUndefined()
    rendered.unmount()
  })
})
