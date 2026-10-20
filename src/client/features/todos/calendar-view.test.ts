// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { buildMonthGridCells } from '../../components/calendar-grids'
import { initI18n, localeTag, t } from '../../lib/i18n'
import { addDaysKey, daysBetweenKeys, weekStartFor } from '../../lib/time'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarView } from './CalendarView'
import { useTodos } from './store'

interface ListParams {
  view?: string
  dueFrom?: string
  dueTo?: string
  limit?: number
}

function row(id: string, title: string, dueAt: number): TodoTask {
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
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

const service = vi.hoisted(() => ({
  requests: [] as ListParams[],
  rows: [] as TodoTask[],
  answer(params: ListParams): Record<string, unknown> {
    service.requests.push(params)
    return {
      tasks: service.rows,
      total: service.rows.length,
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
  useTodos.setState({ timezone: 'UTC', editorOpen: false, draft: null })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.unstubAllGlobals()
})

describe('the calendar view', () => {
  it('draws a month of day cells and at most three titles per day', async () => {
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

    const cell = container.querySelector<HTMLElement>(`[data-calendar-day="${dayKey(YEAR, MONTH, 5)}"]`)
    expect(cell, 'the fifth day has no cell').not.toBeNull()
    expect(cell!.textContent).toContain('Alpha')
    expect(cell!.textContent).toContain('Bravo')
    expect(cell!.textContent).toContain('Charlie')
    expect(cell!.textContent).not.toContain('Delta')
    expect(cell!.textContent).toContain('+1')
    expect(service.requests[0]?.limit).toBe(500)
    expect(service.requests[0]?.view).toBe('open')
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

  it('opens the editor on the day a cell is activated from the keyboard', async () => {
    const container = await mount()
    const key = dayKey(YEAR, MONTH, 5)
    const cell = container.querySelector<HTMLButtonElement>(`[data-calendar-day="${key}"]`)
    expect(cell).not.toBeNull()

    await act(async () => {
      cell!.focus()
      cell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().draft?.dueAt).toBe(key)
  })

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
})
