// @vitest-environment jsdom
/**
 * The controls that change what the server is asked for, rather than what the browser holds.
 *
 * A filter is only a filter if the question leaves the page: a control that changes a variable and
 * then slices the rows already in memory looks right on a small account and silently answers a
 * different question past the first page. Each case here presses the control the way a reader does and
 * reads the request the fake service received, which is the same line the search cases hold.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { localDate } from '@shared/assistant-time'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  rows: [] as TodoTask[],
  counts: {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0,
    byList: { inbox: { open: 0, done: 0 }, L1: { open: 0, done: 0 } }, byTag: {},
  },
  answer(params: Record<string, unknown>): Record<string, unknown> {
    service.requests.push(params)
    let matched = service.rows
    // The collection filter is the server's job, so the stand-in honours it: a client that kept
    // slicing the unfiltered page would show the wrong rows here even if it sent the parameter.
    if (typeof params.list === 'string') {
      matched = matched.filter((task) => (params.list === 'none' ? task.listId === null : task.listId === params.list))
    }
    const limit = Number(params.limit ?? 0)
    const offset = Number(params.offset ?? 0)
    return {
      tasks: matched.slice(offset, offset + limit),
      total: matched.length,
      counts: service.counts,
      dayEnd: Date.now() + 3_600_000,
      timezone: 'UTC',
    }
  },
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async (params: Record<string, unknown> = {}) => service.answer(params),
      lists: async () => ({ lists: [{ id: 'L1', name: 'Work', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 }] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

/** A row the way the route serialises one. */
function task(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: Date.parse('2026-10-01T08:00:00Z'),
    updatedAt: Date.parse('2026-10-01T08:00:00Z'),
    listId: 'L1',
    tags: [],
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

function rows(count: number, extra: Partial<TodoTask> = {}): TodoTask[] {
  return Array.from({ length: count }, (_, index) => task(`t${index}`, `Task ${index}`, { dueAt: index * 60_000, ...extra }))
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(address = '/todo'): Promise<HTMLElement> {
  window.history.replaceState(null, '', address)
  await act(async () => { view = renderElement(createElement(TodosApp)) })
  await settle()
  return view!.container
}

function lastRequest(): Record<string, unknown> {
  return service.requests.at(-1) ?? {}
}

function selectByLabel(container: HTMLElement, label: string): HTMLSelectElement | null {
  return [...container.querySelectorAll('select')].find((node) => node.getAttribute('aria-label') === label) ?? null
}

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    input.focus()
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement | null {
  return [...container.querySelectorAll('input')].find((node) => node.getAttribute('aria-label') === label) ?? null
}

/** Calendar arithmetic on the local day strings the presets are made of, with no timezone in it. */
function shift(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return date.toISOString().slice(0, 10)
}

function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return shift(day, -((dow + 6) % 7))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.rows = rows(3)
  useTodos.setState(original, true)
  window.history.replaceState(null, '', '/todo')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
  useTodos.setState(original, true)
})

describe('the order a listing is read in', () => {
  it('asks the server for the order the reader picked, and says so in the address', async () => {
    stubBreakpoint(true)
    const container = await mount()

    const select = selectByLabel(container, t('todo.filter.sort'))
    expect(select, 'the board has no way to ask for an order').not.toBeNull()
    // The default is the server's own: no parameter, and the word for the order the server uses.
    expect(select!.value).toBe('due')
    expect(lastRequest().sort, 'the default order was sent as if it were a choice').toBeUndefined()

    choose(select!, 'priority')
    await settle()

    expect(lastRequest().sort, 'the order never left the browser').toBe('priority')
    expect(window.location.search).toContain('sort=priority')
  })

  it('reads the order back out of a shared address', async () => {
    stubBreakpoint(true)
    const container = await mount('/todo?sort=created')

    expect(lastRequest().sort).toBe('created')
    const select = selectByLabel(container, t('todo.filter.sort'))
    expect(select?.value).toBe('created')
  })

  it('shows the completed list’s own default rather than a sort the server would not use', async () => {
    stubBreakpoint(true)
    service.rows = rows(3, { status: 'done', completedAt: Date.parse('2026-10-18T09:00:00Z') })
    const container = await mount('/todo?view=completed')

    expect(lastRequest().sort, 'the completed view’s default was overridden').toBeUndefined()
    expect(selectByLabel(container, t('todo.filter.sort'))?.value).toBe('completed')
  })

  it('gives a phone the same control, in the tab order', async () => {
    stubBreakpoint(false)
    const container = await mount('/todo?list=L1')

    const select = selectByLabel(container, t('todo.filter.sort'))
    expect(select, 'the order is unreachable on a phone').not.toBeNull()
    act(() => { select!.focus() })
    expect(document.activeElement).toBe(select)
  })
})

describe('the due window a listing is read through', () => {
  it('sends each preset as the half-open window it means, and clears back to any date', async () => {
    stubBreakpoint(true)
    const container = await mount()
    const today = localDate(Date.now(), 'UTC')
    const due = selectByLabel(container, t('todo.filter.due'))
    expect(due, 'a due window cannot be chosen at all').not.toBeNull()
    expect(due!.value).toBe('any')

    choose(due!, 'today')
    await settle()
    expect(lastRequest().dueFrom, 'today’s window never left the browser').toBe(`${today}T00:00`)
    expect(lastRequest().dueTo).toBe(`${shift(today, 1)}T00:00`)
    expect(window.location.search).toContain('dueFrom=')

    choose(due!, 'week')
    await settle()
    const monday = mondayOf(today)
    expect(lastRequest().dueFrom).toBe(`${monday}T00:00`)
    expect(lastRequest().dueTo).toBe(`${shift(monday, 7)}T00:00`)

    choose(due!, 'next30')
    await settle()
    expect(lastRequest().dueFrom).toBe(`${today}T00:00`)
    expect(lastRequest().dueTo).toBe(`${shift(today, 30)}T00:00`)

    choose(due!, 'any')
    await settle()
    expect(lastRequest().dueFrom, 'clearing the window left the bound behind').toBeUndefined()
    expect(lastRequest().dueTo).toBeUndefined()
    expect(window.location.search).not.toContain('dueFrom=')
  })

  it('takes a custom start and end, with the end day included', async () => {
    stubBreakpoint(true)
    const container = await mount()
    choose(selectByLabel(container, t('todo.filter.due'))!, 'custom')
    await settle()

    const from = inputByLabel(container, t('todo.due.from'))
    const to = inputByLabel(container, t('todo.due.to'))
    expect(from, 'a custom range opens no start field').not.toBeNull()
    expect(to, 'a custom range opens no end field').not.toBeNull()

    typeInto(from!, '2026-10-05')
    await settle()
    typeInto(to!, '2026-10-09')
    await settle()

    expect(lastRequest().dueFrom).toBe('2026-10-05T00:00')
    // The bound is exclusive on the route, so the day the reader picked ends at the next midnight.
    expect(lastRequest().dueTo).toBe('2026-10-10T00:00')
  })

  it('reads a custom window back out of a shared address', async () => {
    stubBreakpoint(true)
    const container = await mount('/todo?dueFrom=2026-10-05T00:00&dueTo=2026-10-10T00:00')

    expect(lastRequest().dueFrom).toBe('2026-10-05T00:00')
    expect(lastRequest().dueTo).toBe('2026-10-10T00:00')
    expect(selectByLabel(container, t('todo.filter.due'))?.value).toBe('custom')
    expect(inputByLabel(container, t('todo.due.from'))?.value).toBe('2026-10-05')
    expect(inputByLabel(container, t('todo.due.to'))?.value).toBe('2026-10-09')
  })
})
