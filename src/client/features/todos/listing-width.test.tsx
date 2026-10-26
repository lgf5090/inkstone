// @vitest-environment jsdom
/**
 * How wide a reading page is, and how many columns a board is allowed to reserve.
 *
 * Both of these are layout declarations, and jsdom lays nothing out — the geometry the audit measured
 * (a row's title 1300px from its own menu; four 390px tracks holding three cards) can only be re-measured
 * in a browser. What a case like this can still do is pin the *rule* the fix is built on: the reading
 * column declares a ceiling from the widths this feature already keeps, the board declares tracks that
 * follow its cards instead of the viewport, and the two surfaces stay different because they answer
 * different questions.
 *
 * The board is asserted to stay uncapped on purpose: giving it the reading column's ceiling would put
 * the cards back into a narrow band and leave the page empty beside them — the same defect, moved.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: counts(), dayEnd: NOW + 86_400_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
    },
  },
}))

import { BoardView } from './BoardView'
import { GroupedTaskList } from './TaskViews'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-19T09:00:00Z')

function counts(): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
}

function list(id: string, name: string): TaskListEntry {
  return {
    id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0,
    openCount: 1, doneCount: 0, archivedAt: null, parentId: null,
  }
}

function row(id: string): TodoTask {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

let view: RenderedElement | null = null

function mount(node: Parameters<typeof renderElement>[0]): HTMLElement {
  // One page at a time: a page left mounted keeps answering the store, and the writes a later case makes
  // would be updates nothing in that case wrapped.
  act(() => { view?.unmount() })
  view = renderElement(node)
  return view.container
}

/** The element a page is drawn inside, found by the role it announces itself as.
 *
 * Both the reading column and the board's grid mark that container, and a case mounts one of them.
 */
function listColumn(container: HTMLElement): HTMLElement {
  const column = container.querySelector<HTMLElement>('[role="list"]')
  if (!column) throw new Error('the page drew no list')
  return column
}

function mountRows(count: number): HTMLElement {
  const tasks = Array.from({ length: count }, (_, index) => row(`t${index}`))
  useTodos.setState({ tasks })
  return mount(createElement(GroupedTaskList, {
    groups: [{ key: 'open', tasks }],
    label: () => t('todo.group.open'),
    empty: { title: t('todo.empty.list'), description: t('todo.empty.list_hint') },
  }))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState({
    status: 'ready',
    error: null,
    tasks: [] as TodoTask[],
    completed: [] as TodoTask[],
    lists: [],
    tags: [],
    counts: counts(),
    selectedIds: new Set<string>(),
    view: 'board',
    listId: null,
    tagId: null,
    sort: null,
    query: '',
    dueFrom: null,
    dueTo: null,
    dayEnd: NOW + 86_400_000,
    timezone: 'UTC',
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the width a reading page is drawn in', () => {
  it('caps the column of rows and puts it in the middle of the page', () => {
    const column = listColumn(mountRows(3))
    expect(column.className).toContain('max-w-[')
    expect(column.className).toContain('mx-auto')
  })

  it('keeps the cap inside the widths this feature already reads at', () => {
    // The organizer's lists are 640 and the statistics 1080; a page of short sentences belongs between
    // them rather than at either edge, and the ceiling being a number in that span is the rule.
    const px = Number(/max-w-\[(\d+)px\]/.exec(listColumn(mountRows(2)).className)?.[1] ?? NaN)
    expect(px).toBeGreaterThanOrEqual(640)
    expect(px).toBeLessThanOrEqual(1080)
  })

  it('leaves the board uncapped, because its cards are columns to place work in', () => {
    useTodos.setState({ lists: [list('L1', 'Work'), list('L2', 'Home')], tasks: [row('a')] })
    const container = mount(createElement(BoardView, { onOpenList: () => {} }))
    const grid = listColumn(container)
    expect(grid.className).not.toContain('max-w-')
    expect(container.querySelectorAll('section[aria-label]').length).toBe(3)
  })
})

describe('the columns a board reserves', () => {
  it('repeats tracks as the cards need them rather than as the viewport says', () => {
    useTodos.setState({ lists: [list('L1', 'Work'), list('L2', 'Home'), list('L3', 'Else')], tasks: [] })
    const grid = listColumn(mount(createElement(BoardView, { onOpenList: () => {} })))
    expect(grid.className).toMatch(/repeat\(\s*auto-fit/)
    for (const viewport of ['grid-cols-1', 'min-[420px]:grid-cols-2', 'lg:grid-cols-3', '2xl:grid-cols-4']) {
      expect(grid.className, `the board still keys its columns to the viewport: ${viewport}`).not.toContain(viewport)
    }
  })

  it('keeps one floor a phone can hold and the gap the cards were spaced by', () => {
    const grid = listColumn(mount(createElement(BoardView, { onOpenList: () => {} })))
    // `min(100%, …)` is what stops the narrowest viewport from being given a track wider than the page.
    expect(grid.className).toMatch(/minmax\(\s*min\(100%,\s*\d+px\)\s*,\s*1fr\s*\)/)
    expect(grid.className).toContain('gap-2.5')
  })

  it('draws one card per collection, including the inbox', () => {
    useTodos.setState({ lists: [list('L1', 'Work'), list('L2', 'Home')], tasks: [row('a')] })
    const container = mount(createElement(BoardView, { onOpenList: () => {} }))
    expect([...container.querySelectorAll('section[aria-label]')].map((node) => node.getAttribute('aria-label')))
      .toEqual([t('todo.smart.inbox'), 'Work', 'Home'])
  })
})
