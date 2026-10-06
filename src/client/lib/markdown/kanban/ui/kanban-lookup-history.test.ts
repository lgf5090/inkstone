/**
 * The acceptance case for one idea: narrowing a board is not an edit.
 *
 * A reader who touches a card and then looks at the board a dozen different ways — types three
 * searches, opens the tag chip, sets a filter, sorts a column twice, shrinks the cards, hides a column,
 * prints another field on them, regroups, sets a swimlane, opens another view and comes back — has done
 * one thing to the board and eleven things to how they are looking at it. Ctrl+Z after that run means
 * the card. Before this, every one of those eleven took a step, so a handful of lookups walked a
 * session's real edits off the end of the thirty-step history (review 2026-09-23: clicking a few
 * filters pushed the reader's real card edits out of the history, and Ctrl+Z ran a filter back instead
 * of the edit before it).
 *
 * Everything below is driven through the board the way a reader drives it — writers taken off the root
 * state, the same ones the header, the tab strip, the filter panel, the tag chips, the table's column
 * picker, the card-fields row and the grouping picker call. A writer that quietly went back to taking a
 * step, or a new reader-facing control that was wired to a step-taking writer, turns this red; a
 * hand-made commit that happened to pass the right kind would not have.
 */
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { installTestGlobals } from '../../../test-render'
import { useKanbanRootState } from './kanban-root-hooks'
import type { KanbanData, KanbanFilter } from '../types'

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useUi.setState({ toasts: [] })
})

type RootState = ReturnType<typeof useKanbanRootState>

const boardFilters: KanbanFilter[] = [{ propertyId: 'status', operator: 'equals', value: 'todo' }]

function boardWithOneCard(): KanbanData {
  return {
    title: 'Board',
    activeViewId: 'view-board',
    views: [
      { id: 'view-board', name: 'Board', type: 'board', groupBy: 'status' },
      { id: 'view-table', name: 'Table', type: 'table' },
    ],
    columns: [
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
    ],
    items: [{ id: 'a', title: 'A', properties: { status: 'todo' } }],
  }
}

function renderRootStateProbe(initialData: KanbanData = boardWithOneCard()) {
  installTestGlobals()
  const holder: { state: RootState } = { state: null as unknown as RootState }
  const commits: KanbanData[] = []
  const onUpdateData = vi.fn((next: KanbanData) => { commits.push(next) })

  function Probe() {
    const containerRef = useRef<HTMLElement | null>(null)
    holder.state = useKanbanRootState(initialData, onUpdateData, containerRef)
    return createElement('div', { ref: containerRef })
  }

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Probe)) })
  const unmount = () => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { holder, commits, unmount }
}

function lastToast() {
  return useUi.getState().toasts.at(-1)
}

/** Twelve real lookups, each through the writer the control that offers it calls. */
function lookAtTheBoardDifferently(state: RootState) {
  const { filterSort } = state
  act(() => { filterSort.setSearchQuery('a') })
  act(() => { filterSort.setSearchQuery('al') })
  act(() => { filterSort.setSelectedTags(['urgent']) })
  act(() => { filterSort.setFilters(boardFilters) })
  act(() => { filterSort.setSorts([{ propertyId: 'title', direction: 'asc' }]) })
  act(() => { filterSort.toggleSortColumn('status') })
  act(() => { filterSort.setCardSize('small') })
  act(() => { filterSort.toggleHiddenColumn('status') })
  act(() => { filterSort.toggleCardField('status') })
  act(() => { state.columnOps.handleChangeGroupBy('status') })
  act(() => { filterSort.updateActiveView({ swimlaneBy: 'status' }) })
  act(() => { state.setActiveViewId('view-table') })
  act(() => { state.setActiveViewId('view-board') })
}

describe('a run of lookups leaves the reader one step back, to their last edit', () => {
  it('undoes the card edit rather than walking back through the lookups', () => {
    const { holder, unmount } = renderRootStateProbe()
    act(() => { holder.state.items.handleUpdateTitle('a', 'A renamed') })
    expect(holder.state.data.items[0]!.title).toBe('A renamed')
    lookAtTheBoardDifferently(holder.state)
    expect(holder.state.history.canUndo, 'the lookups took steps of their own').toBe(true)
    act(() => { holder.state.history.undo() })
    expect(holder.state.data.items[0]!.title).toBe('A')
    expect(holder.state.history.canUndo, 'there was more than one step on the way back').toBe(false)
    unmount()
  })

  it('lets a second undo go on to the edit before it, not to a lookup', () => {
    const { holder, unmount } = renderRootStateProbe()
    act(() => { holder.state.items.handleUpdateTitle('a', 'A renamed') })
    act(() => { holder.state.columnOps.handleUpdateColumn('todo', { label: 'Backlog' }) })
    lookAtTheBoardDifferently(holder.state)
    act(() => { holder.state.history.undo() })
    expect(holder.state.data.columns[0]!.options![0]!.label).toBe('To Do')
    act(() => { holder.state.history.undo() })
    expect(holder.state.data.items[0]!.title).toBe('A')
    unmount()
  })
})

describe('the lookups are still written into the document they are handed', () => {
  it('hands over every narrowed view state, one commit at a time', () => {
    const { holder, commits, unmount } = renderRootStateProbe()
    lookAtTheBoardDifferently(holder.state)
    const written = commits.at(-1)!
    expect(written.activeViewId).toBe('view-board')
    expect(written.views[0]).toMatchObject({
      searchQuery: 'al',
      selectedTags: ['urgent'],
      filters: boardFilters,
      cardSize: 'small',
      hiddenColumns: ['status'],
      cardFields: ['status'],
      groupBy: 'status',
      swimlaneBy: 'status',
    })
    unmount()
  })

  // A view the reader owns is not a lookup: deleting one keeps its step, and that step is what the
  // toast hands over. Were the delete to go in as a lookup, the toast's undo would jump past it to the
  // edit before and the view would never come back.
  it('keeps a step for a view that is deleted, in the middle of a run of lookups', () => {
    const { holder, commits, unmount } = renderRootStateProbe()
    lookAtTheBoardDifferently(holder.state)
    act(() => { holder.state.viewOps.deleteView('view-table') })
    expect(holder.state.data.views.map((v) => v.id)).toEqual(['view-board'])
    act(() => { lastToast()!.action!.run() })
    expect(commits.at(-1)!.views.map((v) => v.id)).toEqual(['view-board', 'view-table'])
    unmount()
  })
})
