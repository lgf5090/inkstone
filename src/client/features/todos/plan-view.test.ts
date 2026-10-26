// @vitest-environment jsdom
/**
 * The plan page, and the horizon the sidebar offers beside it.
 *
 * The plan splits its rows by *when* they are owed — overdue, today, the next week, further out, no
 * date — so the page it is handed has to be wide enough to hold all five answers. Asking the server for
 * today's shelf and then grouping it by when is how this page used to show three permanently empty
 * headings, so these cases hold the fake service to the scoping the real route does: a view decides
 * which rows come back, and a page that asks for the wrong one simply does not receive the rows.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

/** A week is the horizon `UPCOMING_DAYS` names; the page does not decide it, the route does. */
const DAY = 24 * 60 * 60 * 1000

const service = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  rows: [] as TodoTask[],
  counts: {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
  },
  dayEnd: Date.now() + 3_600_000,
  /**
   * The rows one view names, the way the route's WHERE clause hands back a different set per view.
   *
   * Only the three views this page is about are scoped; every other view answers with the whole table,
   * because copying the rest of the route is not what these cases are watching.
   */
  scoped(view: string): TodoTask[] {
    const dayEnd = service.dayEnd
    const upcomingEnd = dayEnd + 7 * DAY
    const open = service.rows.filter((task) => task.status !== 'done')
    if (view === 'open') return open
    if (view === 'today') {
      return open.filter((task) => (task.dueAt !== null && task.dueAt < dayEnd) || (task.dueAt === null && task.status === 'in_progress'))
    }
    if (view === 'upcoming') {
      return open.filter((task) => task.dueAt !== null && task.dueAt >= dayEnd && task.dueAt < upcomingEnd)
    }
    return open
  },
  answer(params: Record<string, unknown>): Record<string, unknown> {
    service.requests.push(params)
    const matched = service.scoped(String(params.view ?? ''))
    const limit = Number(params.limit ?? 0)
    const offset = Number(params.offset ?? 0)
    return {
      tasks: matched.slice(offset, offset + limit),
      total: matched.length,
      counts: service.counts,
      dayEnd: service.dayEnd,
      timezone: 'UTC',
    }
  },
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async (params: Record<string, unknown> = {}) => service.answer(params),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

/** One row, dated relative to the day the answer says the reader is standing in. */
function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: Date.parse('2026-10-01T08:00:00Z'),
    updatedAt: Date.parse('2026-10-01T08:00:00Z'),
    listId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    noteId: null,
    conversationId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  } as unknown as TodoTask
}

/** Let the page a view asks for land. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 320)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(address = '/todo'): Promise<HTMLElement> {
  window.history.replaceState(null, '', address)
  await act(async () => { view = renderElement(createElement(TodosApp)) })
  await settle()
  return view!.container
}

function lastRequest(): Record<string, unknown> {
  return service.requests.at(-1) as Record<string, unknown>
}

/** The group headings the page on screen is drawing, in the order they read. */
function groupHeadings(container: HTMLElement): string[] {
  return [...container.querySelectorAll('section[aria-label]')].map((node) => node.getAttribute('aria-label') ?? '')
}

function sidebarButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  const nav = container.querySelector<HTMLElement>(`nav[aria-label="${t('todo.a11y.lists')}"]`)
  return [...(nav?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((button) => (button.textContent ?? '').includes(label))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.dayEnd = Date.now() + 3_600_000
  service.counts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
  } as TaskCounts
  service.rows = []
  useTodos.setState(original, true)
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
  useTodos.setState(original, true)
})

describe('the plan page asks for the set it groups', () => {
  it('asks the server for the open set rather than today’s shelf', async () => {
    stubBreakpoint(true)
    await mount('/todo?view=plan')

    expect(lastRequest().view, 'the plan groups by when, so it cannot read only today').toBe('open')
  })

  it('draws the five headings out of the rows the page is wide enough to hold', async () => {
    stubBreakpoint(true)
    service.rows = [
      task('late', { dueAt: service.dayEnd - 2 * DAY }),
      task('today', { dueAt: service.dayEnd - 60_000 }),
      task('soon', { dueAt: service.dayEnd + DAY }),
      task('far', { dueAt: service.dayEnd + 40 * DAY }),
      task('undated'),
    ]
    const container = await mount('/todo?view=plan')

    for (const heading of [
      t('todo.group.overdue'), t('todo.group.today'), t('todo.group.upcoming'),
      t('todo.group.later'), t('todo.group.none'),
    ]) {
      expect(groupHeadings(container), `the plan page never drew ${heading}`).toContain(heading)
    }
  })
})

describe('the upcoming horizon', () => {
  it('gives the sidebar a row that asks the server for its own view', async () => {
    stubBreakpoint(true)
    service.rows = [task('soon', { dueAt: service.dayEnd + DAY })]
    service.counts.upcoming = 1
    const container = await mount()

    const entry = sidebarButton(container, t('todo.view.upcoming'))
    expect(entry, 'the sidebar has no way to reach the next week').not.toBeUndefined()
    expect(entry!.textContent, 'the row does not say how many are in it').toContain('1')

    await act(async () => { entry!.click(); await Promise.resolve() })
    await settle()

    expect(window.location.search).toContain('view=upcoming')
    expect(lastRequest().view).toBe('upcoming')
  })

  it('renders the rows the upcoming view answers with', async () => {
    stubBreakpoint(true)
    service.rows = [
      task('soon', { dueAt: service.dayEnd + DAY }),
      task('today', { dueAt: service.dayEnd - 60_000 }),
    ]
    const container = await mount('/todo?view=upcoming')

    expect(lastRequest().view).toBe('upcoming')
    const ids = [...container.querySelectorAll('[data-todo-open]')].map((node) => node.getAttribute('data-todo-open'))
    expect(ids).toEqual(['soon'])
  })
})
