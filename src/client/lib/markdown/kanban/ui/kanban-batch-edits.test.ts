/**
 * The batch bar could change a group and nothing else, so changing twenty cards' owner meant twenty
 * visits to the detail panel. The three fields a reader actually bulk-edits get an entry here — the
 * assignee, the tags a card carries, and the deadline — and the edits leave the selection standing,
 * because a reader who has just re-aimed twenty cards may well want to tag them next.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { dateKey, addDaysKey } from '../../../time'
import { formatKanbanOptionLabel } from '../i18n-helpers'
import { KanbanBatchBar, type KanbanBatchEdits } from './kanban-batch-bar'
import { useKanbanSelection } from './kanban-root-hooks'
import { KanbanRoot } from './kanban-root'
import type { CommitKanbanData } from './kanban-history'
import type { KanbanData, KanbanItem, KanbanProperty, KanbanView } from '../types'

const BOARD_VIEW: KanbanView = { id: 'v-probe', name: 'Board', type: 'board' }

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const TODO = 'todo'

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [{ id: TODO, label: 'To Do', color: 'gray' }],
}

/** Deliberately not called `owner`: the board's member column is whichever one holds people. */
const membersColumn: KanbanProperty = {
  id: 'members',
  name: 'Members',
  type: 'person',
  options: [
    { id: 'alice', label: 'Alice', color: 'blue' },
    { id: 'bob', label: 'Bob', color: 'green' },
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

function makeItem(id: string, properties: Record<string, unknown> = {}): KanbanItem {
  return { id, title: `Card ${id}`, properties: { status: TODO, ...properties } }
}

function boardData(): KanbanData {
  return {
    columns: [{ id: 'title', name: 'Title', type: 'title' }, statusColumn, membersColumn, tagsColumn],
    items: [makeItem('a', { tags: ['bug'] }), makeItem('b'), makeItem('c')],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
  } as KanbanData
}

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
})

function mountBoard(data = boardData()) {
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

function menuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
}

function menuRow(label: string): HTMLElement {
  const row = menuRows().find((button) => button.textContent === label)
  expect(row, `no menu row labelled ${label} among ${menuRows().map((r) => r.textContent).join(' / ')}`).toBeDefined()
  return row!
}

function rowsBelow(label: string): (string | null)[] {
  const rows = menuRows()
  const parent = rows.findIndex((row) => row.textContent === label)
  expect(parent, `no menu row labelled ${label}`).toBeGreaterThanOrEqual(0)
  return rows.slice(parent + 1).map((row) => row.textContent)
}

function lastCommit(onUpdateData: ReturnType<typeof vi.fn>): KanbanData | undefined {
  const calls = onUpdateData.mock.calls
  return calls.length > 0 ? (calls.at(-1) as [KanbanData])[0] : undefined
}

/** Ticks a card's own checkbox, which is how a test picks a batch to edit. */
function pick(itemId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)
  expect(card, `card ${itemId} is not on the board`).not.toBeNull()
  click(card!.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
}

function openBatchEdits(): void {
  const trigger = document.querySelector<HTMLElement>(`[data-kanban-batch-edits]`)
  expect(trigger, 'the batch bar offers no edits').not.toBeNull()
  click(trigger!)
}

function renderSelection(data = boardData()) {
  const commits: KanbanData[] = []
  const commitData: CommitKanbanData = (next) => {
    const resolved = typeof next === 'function' ? next(data) : next
    commits.push(resolved)
    return resolved
  }
  let api: ReturnType<typeof useKanbanSelection> | null = null
  function Probe() {
    api = useKanbanSelection(commitData, statusColumn, BOARD_VIEW, vi.fn())
    return null
  }
  const rendered = renderElement(createElement(Probe))
  if (!api) throw new Error('probe did not expose the hook api')
  const current = () => api!
  return { current, commits, unmount: rendered.unmount }
}

describe('what a batch field write does', () => {
  it('writes the assignee onto every selected card and leaves the others alone', () => {
    const { current, commits, unmount } = renderSelection()
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleToggleSelect('b') })
    act(() => { current().handleBatchSetProperty('members', 'Alice') })
    expect(commits).toHaveLength(1)
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.members).toBe('Alice')
    expect(commits[0]!.items.find((i) => i.id === 'b')!.properties.members).toBe('Alice')
    expect('members' in commits[0]!.items.find((i) => i.id === 'c')!.properties).toBe(false)
    unmount()
  })

  it('keeps the selection, so a second edit needs no second pass', () => {
    const { current, unmount } = renderSelection()
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleToggleSelect('b') })
    act(() => { current().handleBatchSetProperty('members', 'Alice') })
    expect([...current().selectedIds].sort()).toEqual(['a', 'b'])
    unmount()
  })

  it('clears the deadline when the batch says so, rather than writing an empty day', () => {
    const data = boardData()
    data.items[0] = makeItem('a', { dueDate: '2026-09-01' })
    const { current, commits, unmount } = renderSelection(data)
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleBatchSetProperty('dueDate', undefined) })
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.dueDate).toBeUndefined()
    unmount()
  })

  it('writes nothing at all when no card is selected', () => {
    const { current, commits, unmount } = renderSelection()
    act(() => { current().handleBatchSetProperty('members', 'Alice') })
    act(() => { current().handleBatchAddTag('tags', 'feat') })
    expect(commits).toHaveLength(0)
    unmount()
  })
})

describe('what adding a tag to a batch does', () => {
  it('adds it to what each card already carries', () => {
    const { current, commits, unmount } = renderSelection()
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleToggleSelect('b') })
    act(() => { current().handleBatchAddTag('tags', 'feat') })
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.tags).toEqual(['bug', 'feat'])
    expect(commits[0]!.items.find((i) => i.id === 'b')!.properties.tags).toEqual(['feat'])
    unmount()
  })

  it('does not tag a card twice when it already carries the tag', () => {
    const { current, commits, unmount } = renderSelection()
    act(() => { current().handleToggleSelect('a') })
    act(() => { current().handleBatchAddTag('tags', 'bug') })
    expect(commits[0]!.items.find((i) => i.id === 'a')!.properties.tags).toEqual(['bug'])
    unmount()
  })
})

function renderBar(edits?: KanbanBatchEdits) {
  const rendered = renderElement(
    createElement(KanbanBatchBar, {
      selectedCount: 2,
      onBatchGroupChange: vi.fn(),
      onBatchArchive: vi.fn(),
      onBatchDelete: vi.fn(),
      onClearSelection: vi.fn(),
      ...(edits ? { edits } : {}),
    }),
  )
  mounted.push(rendered)
  return rendered
}

describe('the fields the batch bar offers', () => {
  it('grows no trigger where the host wired no fields', () => {
    const { container } = renderBar()
    expect(container.querySelector('[data-kanban-batch-edits]')).toBeNull()
  })

  it('offers a field only when the board has somewhere to write it', () => {
    renderBar({ onAssign: vi.fn(), assignees: [], tags: [tagsColumn.options![0]!], onAddTag: vi.fn() })
    openBatchEdits()
    expect(menuRows().map((row) => row.textContent)).toEqual([t('preview.kanban_batch_tag')])
  })

  it('grows no trigger at all when every field it was given is empty', () => {
    const { container } = renderBar({ onAssign: vi.fn(), assignees: [] })
    expect(container.querySelector('[data-kanban-batch-edits]')).toBeNull()
  })

  it('lists the assignee, the tag and the deadline as submenus', () => {
    renderBar({ assignees: ['Alice'], tags: [tagsColumn.options![0]!], onAssign: vi.fn(), onAddTag: vi.fn(), onSetDueDate: vi.fn() })
    openBatchEdits()
    const labels = menuRows().map((row) => row.textContent)
    expect(labels).toEqual([
      t('preview.kanban_batch_assignee'),
      t('preview.kanban_batch_tag'),
      t('preview.kanban_batch_due_date'),
    ])
  })

})

describe('what a batch edit reports back', () => {
  it('reports the person the reader picked from the roster', () => {
    const onAssign = vi.fn()
    const { unmount } = renderBar({ assignees: ['Alice', 'Bob'], onAssign })
    openBatchEdits()
    click(menuRow(t('preview.kanban_batch_assignee')))
    click(menuRow('Bob'))
    expect(onAssign).toHaveBeenCalledWith('Bob')
    unmount()
  })

  it('offers the deadline as days a reader picks, not a calendar to fill in', () => {
    const onSetDueDate = vi.fn()
    const { unmount } = renderBar({ onSetDueDate })
    openBatchEdits()
    click(menuRow(t('preview.kanban_batch_due_date')))
    expect(rowsBelow(t('preview.kanban_batch_due_date'))).toEqual([
      t('preview.kanban_today'),
      t('preview.kanban_tomorrow'),
      t('preview.kanban_next_week'),
      t('preview.kanban_clear_date'),
    ])
    click(menuRow(t('preview.kanban_tomorrow')))
    expect(onSetDueDate).toHaveBeenCalledWith(addDaysKey(dateKey(new Date()), 1))
    unmount()
  })

  it('reports clearing the deadline as a choice of its own', () => {
    const onSetDueDate = vi.fn()
    const { unmount } = renderBar({ onSetDueDate })
    openBatchEdits()
    click(menuRow(t('preview.kanban_batch_due_date')))
    click(menuRow(t('preview.kanban_clear_date')))
    expect(onSetDueDate).toHaveBeenCalledWith(undefined)
    unmount()
  })
})

describe('editing a batch picked off the board', () => {
  it('assigns one person to every card of a column', () => {
    const { onUpdateData } = mountBoard()
    pick('a')
    pick('b')
    openBatchEdits()
    click(menuRow(t('preview.kanban_batch_assignee')))
    click(menuRow('Alice'))
    expect(lastCommit(onUpdateData)!.items.map((item) => item.properties.members)).toEqual(['Alice', 'Alice', undefined])
  })

  it('adds a tag to the picked cards and keeps them picked', () => {
    const { container, onUpdateData } = mountBoard()
    pick('a')
    pick('b')
    openBatchEdits()
    click(menuRow(t('preview.kanban_batch_tag')))
    click(menuRow(formatKanbanOptionLabel(tagsColumn.options![0]!, 'tags')))
    expect(lastCommit(onUpdateData)!.items.find((item) => item.id === 'a')!.properties.tags).toEqual(['bug', 'feat'])
    expect(container.textContent).toContain(t('preview.kanban_batch_selected_count', { count: 2 }))
  })
})
