// @vitest-environment jsdom
/**
 * The calendar: the month grid, the week's hour axis, and the day panel.
 *
 * A cell is a container of buttons now, not one big button: the date opens the day, a title opens the
 * task, and the plus files a new one. That is what lets the calendar act on a task instead of only
 * pointing at the day it falls on.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { MAX_TASKS_PER_QUERY } from '@shared/todos/model'
import { buildMonthGridCells } from '../../components/calendar-grids'
import { initI18n, localeTag, t } from '../../lib/i18n'
import { addDaysKey, daysBetweenKeys, weekStartFor } from '../../lib/time'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { CalendarView } from './CalendarView'
import { useTodos } from './store'

interface ListParams {
  view?: string
  dueFrom?: string
  dueTo?: string
  limit?: number
}

function row(id: string, title: string, dueAt: number, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt,
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
    ...extra,
  }
}

const service = vi.hoisted(() => ({
  requests: [] as ListParams[],
  rows: [] as TodoTask[],
  /** When set, the listing answers this `total` instead of its own row count, to model a truncated page. */
  totalOverride: undefined as number | undefined,
  answer(params: ListParams): Record<string, unknown> {
    service.requests.push(params)
    return {
      tasks: service.rows,
      total: service.totalOverride ?? service.rows.length,
      counts: {
        inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
      },
      dayEnd: Date.now() + 3_600_000,
      timezone: 'UTC',
    }
  },
}))

vi.mock('../../lib/api', () => ({
  api: { todos: { list: async (params: ListParams = {}) => service.answer(params) } },
}))

const original = useTodos.getState()
let view: RenderedElement | null = null

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(): Promise<HTMLElement> {
  await act(async () => { view = renderElement(createElement(CalendarView)) })
  await settle()
  return view!.container
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const now = new Date()
const YEAR = now.getFullYear()
const MONTH = now.getMonth()

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.rows = []
  service.totalOverride = undefined
  useTodos.setState({ timezone: 'UTC', editorOpen: false, draft: null })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.unstubAllGlobals()
})

describe('the month grid', () => {
  it('draws a month of days and at most three titles per day', async () => {
    stubBreakpoint(true)
    const due = Date.UTC(YEAR, MONTH, 5, 9)
    service.rows = [
      row('a', 'Alpha', due),
      row('b', 'Bravo', due),
      row('c', 'Charlie', due),
      row('d', 'Delta', due),
    ]

    const container = await mount()

    const cells = container.querySelectorAll('[data-calendar-day]')
    expect(cells.length % 7).toBe(0)
    expect(cells.length).toBeGreaterThanOrEqual(28)

    const cell = container.querySelector<HTMLElement>(`[data-calendar-cell="${dayKey(YEAR, MONTH, 5)}"]`)
    expect(cell, 'the fifth day has no cell').not.toBeNull()
    expect(cell!.textContent).toContain('Alpha')
    expect(cell!.textContent).toContain('Bravo')
    expect(cell!.textContent).toContain('Charlie')
    expect(cell!.textContent).not.toContain('Delta')
    expect(cell!.textContent).toContain('+1')
    expect(service.requests[0]?.limit).toBe(500)
    expect(service.requests[0]?.view).toBe('open')
  })

  it('draws colour dots and a count on a phone instead of unreadable titles', async () => {
    stubBreakpoint(false)
    const due = Date.UTC(YEAR, MONTH, 5, 9)
    service.rows = [
      row('a', 'Alpha', due),
      row('b', 'Bravo', due),
      row('c', 'Charlie', due),
      row('d', 'Delta', due),
    ]
    const container = await mount()
    const cell = container.querySelector<HTMLElement>(`[data-calendar-cell="${dayKey(YEAR, MONTH, 5)}"]`)
    expect(cell, 'the fifth day has no cell').not.toBeNull()
    expect(cell!.textContent).not.toContain('Alpha')
    expect(cell!.textContent).toContain('+1')
    const day = container.querySelector<HTMLElement>(`[data-calendar-day="${dayKey(YEAR, MONTH, 5)}"]`)
    expect(day!.getAttribute('aria-label')).toContain('4')
  })

  it('asks for the neighbouring month when the reader moves on', async () => {
    const container = await mount()
    const first = service.requests[0] as ListParams

    const next = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.calendar.next')}"]`)
    expect(next, 'no way to reach the next month').not.toBeNull()
    act(() => { next!.click() })
    await settle()

    const second = service.requests.at(-1) as ListParams
    expect(second.dueFrom).not.toBe(first.dueFrom)
    const cursor = new Date(YEAR, MONTH + 1, 1)
    const cells = buildMonthGridCells(cursor.getFullYear(), cursor.getMonth(), weekStartFor(localeTag()))
    expect(second.dueFrom).toBe(`${cells[0]!.key}T00:00`)
    expect(second.dueTo).toBe(`${addDaysKey(cells[cells.length - 1]!.key, 1)}T00:00`)
  })

  it('says the month is empty when no task falls in it', async () => {
    const container = await mount()
    expect(container.textContent).toContain(t('todo.empty.plan'))
    expect(container.querySelectorAll('[data-calendar-day]').length).toBeGreaterThanOrEqual(28)
  })

  it('says the window was cut short when the listing carries only its first page', async () => {
    stubBreakpoint(true)
    // The route caps one listing at MAX_TASKS_PER_QUERY; when the month holds more than a page, the
    // calendar must not draw it as if the whole window were on screen.
    const due = Date.UTC(YEAR, MONTH, 5, 9)
    service.rows = Array.from({ length: MAX_TASKS_PER_QUERY }, (_unused, index) =>
      row(`t${index}`, `Task ${index}`, due))
    service.totalOverride = MAX_TASKS_PER_QUERY + 40

    const container = await mount()

    const notice = container.querySelector<HTMLElement>('[data-calendar-truncated]')
    expect(notice, 'a truncated window says nothing about the rows it left out').not.toBeNull()
    expect(notice!.textContent).toContain(t('todo.calendar.truncated', { count: MAX_TASKS_PER_QUERY }))
  })

  it('draws one bar across the days a task covers, not a title per day', async () => {
    stubBreakpoint(true)
    const start = Date.UTC(YEAR, MONTH, 5, 9)
    const end = Date.UTC(YEAR, MONTH, 8, 17)
    service.rows = [row('span', 'Conference', end, { startAt: start })]

    const container = await mount()

    const bar = container.querySelector<HTMLElement>('[data-calendar-span="span"]')
    expect(bar, 'a task with a start date drew no bar').not.toBeNull()
    expect(bar!.textContent).toContain('Conference')
    // The bar covers the columns its days fall in, and it is drawn once.
    expect(bar!.style.gridColumn).not.toBe('')
    expect(container.querySelectorAll('[data-calendar-span="span"]')).toHaveLength(1)
  })
})

describe('the day panel', () => {
  it('opens on a day and files a task on it', async () => {
    stubBreakpoint(true)
    const container = await mount()
    const key = dayKey(YEAR, MONTH, 5)
    const day = container.querySelector<HTMLButtonElement>(`[data-calendar-day="${key}"]`)
    expect(day).not.toBeNull()

    await act(async () => {
      day!.click()
      await Promise.resolve()
    })

    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel, 'the day opened no panel').not.toBeNull()
    const add = [...(panel?.querySelectorAll('button') ?? [])]
      .find((node) => (node.textContent ?? '').trim() === t('todo.calendar.add_on_day'))
    expect(add, 'the day panel offers no way to add a task').not.toBeUndefined()
    await act(async () => {
      add!.click()
      await Promise.resolve()
    })

    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().draft?.dueAt).toBe(key)
  })

  it('completes a task from the day panel', async () => {
    stubBreakpoint(true)
    const due = Date.UTC(YEAR, MONTH, 5, 9)
    service.rows = [row('a', 'Alpha', due)]
    const toggled = vi.fn(async (_task: TodoTask) => {})
    useTodos.setState({ toggleTask: toggled })
    const container = await mount()

    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-calendar-day="${dayKey(YEAR, MONTH, 5)}"]`)!.click()
      await Promise.resolve()
    })
    const rowNode = document.querySelector<HTMLElement>('[data-agenda-task="a"]')
    expect(rowNode, 'the day panel did not list the task').not.toBeNull()
    const checkbox = rowNode!.querySelector<HTMLButtonElement>('[role="checkbox"]')
    expect(checkbox, 'the day panel offers no way to finish the task').not.toBeNull()
    await act(async () => {
      checkbox!.click()
      await Promise.resolve()
    })

    expect(toggled).toHaveBeenCalledTimes(1)
    expect(toggled.mock.calls[0]![0]).toMatchObject({ id: 'a', title: 'Alpha' })
  })
})

describe('the week grid', () => {
  it('switches to a seven-day week and asks for exactly that window', async () => {
    const container = await mount()
    const week = [...container.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').trim() === t('preview.kanban_calendar_week'))
    expect(week, 'no week switch on the calendar').toBeDefined()

    act(() => { week!.click() })
    await settle()

    const last = service.requests.at(-1) as ListParams
    const from = last.dueFrom!.slice(0, 10)
    const to = last.dueTo!.slice(0, 10)
    expect(daysBetweenKeys(from, to)).toBe(7)
    expect(container.querySelectorAll('[data-calendar-day]').length).toBe(7)
  })

  it('places a timed task on the hour axis where it falls', async () => {
    stubBreakpoint(true)
    // The week grid opens on the current week, so the task has to fall inside it.
    const due = Date.UTC(YEAR, MONTH, now.getDate(), 9, 30)
    service.rows = [row('timed', 'Standup', due)]
    const container = await mount()

    const week = [...container.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').trim() === t('preview.kanban_calendar_week'))
    act(() => { week!.click() })
    await settle()

    const block = container.querySelector<HTMLElement>('[title="Standup"]')
    expect(block, 'the timed task is not on the week grid').not.toBeNull()
    // A task with no start time draws a half-hour block ending at its due time: 09:00 is 9 × 44px.
    expect(block!.style.top).toBe('396px')
  })
})
