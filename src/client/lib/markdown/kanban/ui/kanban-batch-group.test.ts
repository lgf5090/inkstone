import { act, createElement } from 'react'
import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { useUi } from '../../../../store/ui'
import { useKanbanSelection } from './kanban-root-hooks'
import { KanbanBatchBar } from './kanban-batch-bar'
import type { CommitKanbanData } from './kanban-history'
import type { KanbanData, KanbanItem, KanbanProperty, KanbanView } from '../types'

const BOARD_VIEW: KanbanView = { id: 'v-probe', name: 'Board', type: 'board' }

beforeAll(async () => {
  await initI18n()
})

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'doing', label: 'Doing', color: 'blue' },
  ],
}

const priorityColumn: KanbanProperty = {
  id: 'priority',
  name: 'Priority',
  type: 'select',
  options: [
    { id: 'high', label: 'High', color: 'red' },
    { id: 'low', label: 'Low', color: 'gray' },
  ],
}

const tagsColumn: KanbanProperty = {
  id: 'tags',
  name: 'Tags',
  type: 'multi-select',
  options: [
    { id: 'feat', label: 'Feat', color: 'blue' },
    { id: 'bug', label: 'Bug', color: 'red' },
  ],
}

function makeItem(id: string): KanbanItem {
  return { id, title: id, properties: { status: 'todo', priority: 'low', tags: ['bug'] } }
}

const baseData: KanbanData = {
  columns: [statusColumn, priorityColumn, tagsColumn],
  items: [makeItem('a'), makeItem('b'), makeItem('c')],
  views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'priority' }],
}

type SelectionApi = ReturnType<typeof useKanbanSelection>

function renderSelection(groupColumn?: KanbanProperty, undo = vi.fn()) {
  const commits: KanbanData[] = []
  const commitData: CommitKanbanData = (next) => {
    const resolved = typeof next === 'function' ? next(baseData) : next
    commits.push(resolved)
    return resolved
  }
  let api: SelectionApi | null = null
  function Probe() {
    api = useKanbanSelection(commitData, groupColumn, BOARD_VIEW, undo)
    return null
  }
  const rendered = renderElement(createElement(Probe))
  if (!api) throw new Error('probe did not expose the hook api')
  const current = () => api!
  return { current, commits, unmount: rendered.unmount }
}

function deleteTwoSelected() {
  const undo = vi.fn()
  const harness = renderSelection(undefined, undo)
  act(() => { harness.current().handleToggleSelect('a') })
  act(() => { harness.current().handleToggleSelect('b') })
  act(() => { harness.current().handleBatchDelete() })
  return { ...harness, undo }
}

function lastToast() {
  const toast = useUi.getState().toasts.at(-1)
  if (!toast) throw new Error('batch delete posted no toast')
  return toast
}

describe('useKanbanSelection batch group change', () => {
  it('writes the group value to the groupColumn property, leaving status untouched', () => {
    const { current, commits, unmount } = renderSelection(priorityColumn)
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleToggleSelect('b') })
    act(() => { current().handleBatchGroupChange('high') })
    const changed = commits[0]!
    expect(changed.items.find((i) => i.id === 'a')!.properties.priority).toBe('high')
    expect(changed.items.find((i) => i.id === 'b')!.properties.priority).toBe('high')
    expect(changed.items.find((i) => i.id === 'c')!.properties.priority).toBe('low')
    expect(changed.items.find((i) => i.id === 'a')!.properties.status).toBe('todo')
    expect(current().selectedIds.size).toBe(0)
    unmount()
  })

  it('falls back to status when the board has no group column', () => {
    const { current, commits, unmount } = renderSelection(undefined)
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleBatchGroupChange('doing') })
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.status).toBe('doing')
    unmount()
  })

  it('stores an array when grouping by a multi-select property', () => {
    const { current, commits, unmount } = renderSelection(tagsColumn)
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleBatchGroupChange('feat') })
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.tags).toEqual(['feat'])
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.status).toBe('todo')
    unmount()
  })
})

describe('useKanbanSelection batch delete feedback', () => {
  beforeEach(() => {
    useUi.setState({ toasts: [] })
  })

  it('reports how many cards the batch removed', () => {
    const { current, commits, unmount } = deleteTwoSelected()
    // Removed from every view, still in the document: the flag is what the deleted list restores.
    expect(commits[0]!.items.map((i) => [i.id, i.deleted])).toEqual([
      ['a', true],
      ['b', true],
      ['c', undefined],
    ])
    expect(current().selectedIds.size).toBe(0)
    expect(lastToast()).toMatchObject({
      title: t('preview.kanban_batch_deleted_count', { count: 2 }),
      action: { label: t('common.undo'), run: expect.any(Function) },
    })
    unmount()
  })

  it('runs the board history undo instead of a second restore path', () => {
    const { undo, commits, unmount } = deleteTwoSelected()
    const action = lastToast().action
    expect(action?.label).toBe(t('common.undo'))
    const commitsBefore = commits.length
    act(() => { action!.run() })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(commits).toHaveLength(commitsBefore)
    unmount()
  })

  it('keeps the undo window open longer than an informational toast', () => {
    const { unmount } = deleteTwoSelected()
    expect(lastToast().duration).toBeGreaterThan(3800)
    unmount()
  })

  it('deletes nothing and says nothing when no card is selected', () => {
    const undo = vi.fn()
    const { current, commits, unmount } = renderSelection(undefined, undo)
    act(() => { current().handleBatchDelete() })
    expect(commits).toHaveLength(0)
    expect(useUi.getState().toasts).toHaveLength(0)
    unmount()
  })
})

function renderBatchBar(groupColumn: KanbanProperty | undefined, onBatchGroupChange: (id: string) => void) {
  const rendered = renderElement(
    createElement(KanbanBatchBar, {
      selectedCount: 2,
      groupColumn,
      onBatchGroupChange,
      onBatchArchive: vi.fn(),
      onBatchDelete: vi.fn(),
      onClearSelection: vi.fn(),
    }),
  )
  return rendered
}

describe('KanbanBatchBar group select', () => {
  it('lists the group column options under a group placeholder and reports the choice', () => {
    const onBatchGroupChange = vi.fn()
    const rendered = renderBatchBar(priorityColumn, onBatchGroupChange)
    const select = rendered.container.querySelector('select')!
    expect(select).toBeTruthy()
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(labels[0]).toBe(t('preview.kanban_batch_change_group'))
    expect(labels.slice(1)).toEqual(['High', 'Low'])
    act(() => {
      select.value = 'high'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onBatchGroupChange).toHaveBeenCalledWith('high')
    rendered.unmount()
  })

  it('renders no select when the group column is missing', () => {
    const rendered = renderBatchBar(undefined, vi.fn())
    expect(rendered.container.querySelector('select')).toBeNull()
    rendered.unmount()
  })
})
