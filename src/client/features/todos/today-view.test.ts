// @vitest-environment jsdom
/**
 * "My Day" as a screen: the pick reaches the plan endpoint, and the address names the view.
 *
 * The server half is pinned in `tests/todos-today.test.ts`; what this file watches is the wiring the
 * server cannot see — that typing into the picker asks for candidates, that pressing one sends the
 * task id and today's account-zone day to `POST /:id/plan`, and that a cold `/todo?view=today`
 * opens on the same screen a reload expects. The API is stubbed at the boundary, so a picker rendered
 * but never wired would fail here rather than pass as "it looks right".
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate } from '@shared/assistant-time'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

interface ListParams {
  view?: string
  q?: string
  limit?: number
  offset?: number
}

function counts(today: number): TaskCounts {
  return { inbox: 0, today, upcoming: 0, overdue: 0, all: today, completed: 0, starred: 0, byList: {}, byTag: {} }
}

/** A row the way the route serialises one. */
function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
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
  plans: [] as { id: string, date: string | null }[],
  /** The today page's rows, and the open shelf the picker searches. */
  pageRows: [] as TodoTask[],
  candidates: [] as TodoTask[],
  answer(params: ListParams): Record<string, unknown> {
    service.requests.push(params)
    const rows = params.q ? service.candidates : service.pageRows
    const limit = Number(params.limit ?? 0)
    const offset = Number(params.offset ?? 0)
    return {
      tasks: rows.slice(offset, offset + limit),
      total: rows.length,
      counts: counts(service.pageRows.length),
      dayEnd: Date.now() + 3_600_000,
      timezone: 'UTC',
    }
  },
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async (params: ListParams = {}) => service.answer(params),
      plan: async (id: string, date: string | null) => {
        service.plans.push({ id, date })
        const found = [...service.candidates, ...service.pageRows].find((task) => task.id === id) ?? row(id, id)
        return { task: { ...found, plannedFor: date } }
      },
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

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(address = '/todo'): Promise<HTMLElement> {
  window.history.replaceState(null, '', address)
  await act(async () => { view = renderElement(createElement(TodosApp)) })
  await settle()
  return view!.container
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    input.focus()
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function lastRequest(): ListParams {
  return service.requests.at(-1) as ListParams
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.plans.length = 0
  service.pageRows = []
  service.candidates = []
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
  useTodos.setState(original, true)
})

describe('the today screen', () => {
  it('opens on the view the address names, so a reload lands where it left off', async () => {
    stubBreakpoint(true)
    service.pageRows = [row('picked', 'Draft the brief', { plannedFor: localDate(Date.now(), 'UTC') })]

    const container = await mount('/todo?view=today')

    expect(lastRequest().view).toBe('today')
    expect(window.location.search).toBe('?view=today')
    expect(container.querySelector('[data-todo-open="picked"]')).not.toBeNull()
  })

  it('plans the task a reader picks, with today’s account-zone day', async () => {
    stubBreakpoint(true)
    service.candidates = [row('remote', 'Renew the lease')]

    const container = await mount('/todo?view=today')
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.today.pick')}"]`)
    expect(field, 'the picker has no field to type a title into').not.toBeNull()

    typeInto(field!, 'renew')
    await settle(260)

    // The search left the page's own listing: it asked the open shelf by title.
    expect(service.requests.some((request) => request.view === 'open' && request.q === 'renew')).toBe(true)

    const choose = [...container.querySelectorAll('button')]
      .find((button) => (button.textContent ?? '').includes('Renew the lease'))
    expect(choose, 'the matching task was never offered').toBeDefined()

    await act(async () => {
      choose!.click()
      await Promise.resolve()
    })
    await settle()

    expect(service.plans).toEqual([{ id: 'remote', date: localDate(Date.now(), 'UTC') }])
  })

  it('clears a plan from the row the reader picked', async () => {
    stubBreakpoint(true)
    const today = localDate(Date.now(), 'UTC')
    service.pageRows = [row('picked', 'Draft the brief', { plannedFor: today })]

    const container = await mount('/todo?view=today')
    const remove = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.today.remove', { title: 'Draft the brief' })}"]`)
    expect(remove, 'a picked row offers no way out of today').not.toBeNull()

    await act(async () => {
      remove!.click()
      await Promise.resolve()
    })
    await settle()

    expect(service.plans).toEqual([{ id: 'picked', date: null }])
  })

  it('offers no way out for a row that is only due today', async () => {
    stubBreakpoint(true)
    service.pageRows = [row('due', 'Send the invoice', { dueAt: Date.now() + 60_000 })]

    const container = await mount('/todo?view=today')

    expect(container.querySelector(`button[aria-label="${t('todo.today.remove', { title: 'Send the invoice' })}"]`)).toBeNull()
  })
})
