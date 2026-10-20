// @vitest-environment jsdom
/**
 * The to-do app's screen as a question it asks the server, rather than a slice of what it already has.
 *
 * The container used to fetch 500 open tasks once and then filter, search and group them in the browser.
 * Past 500 tasks that meant a search reporting "no matches" for a task the reader can see in their own
 * list, so everything the screen states — view, list, tag, search text, page offset — now goes back out
 * as a query parameter, and the client keeps only the grouping. These cases hold the line at the API
 * boundary: what was asked for, and what got rendered out of the answer.
 *
 * The fake service is a stand-in for the route and it is honest about being one: it honours `limit` and
 * `offset` over its own rows and hands back a `total` bigger than the page it sent. A client that kept
 * filtering its page would lose rows here, which is exactly what these cases are watching for.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

interface ListParams {
  view?: string
  list?: string
  tag?: string
  q?: string
  status?: string
  starred?: string
  sort?: string
  limit?: number
  offset?: number
}

const service = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  /** The table a listing without search terms answers from. */
  rows: [] as TodoTask[],
  /** The table one with search terms answers from, as the server's LIKE would pick it. */
  hits: [] as TodoTask[],
  counts: {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0,
    byList: { inbox: { open: 0, done: 0 }, L1: { open: 0, done: 0 } }, byTag: {},
  },
  answer(params: Record<string, unknown>): Record<string, unknown> {
    service.requests.push(params)
    const matched = params.q ? service.hits : service.rows
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

const PAGE_SIZE = 100

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

/** `count` rows titled `Task 0 … count-1`, dated in order, so a slice is recognisable by its titles. */
function rows(count: number, extra: Partial<TodoTask> = {}): TodoTask[] {
  return Array.from({ length: count }, (_, index) => task(`t${index}`, `Task ${index}`, { dueAt: index * 60_000, ...extra }))
}

const original = useTodos.getState()
let view: RenderedElement | null = null

/** The task rows on screen — the ones a reader would say they are looking at. */
function openIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-todo-open]')].map((node) => node.getAttribute('data-todo-open') ?? '')
}

/** Let a debounced search and the page it asks for land, the way a reader's pause would. */
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

function searchField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label]')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.rows = rows(3)
  service.hits = []
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

describe('what the screen asks the server for', () => {
  it('asks the server for the open page the board is showing', async () => {
    stubBreakpoint(true)
    await mount()
    expect(lastRequest().view).toBe('open')
    expect(lastRequest().limit).toBe(PAGE_SIZE)
  })

  it('asks again, for the view the reader moved to, instead of slicing the page it has', async () => {
    stubBreakpoint(true)
    await mount()
    const before = service.requests.length

    await act(async () => { useTodos.getState().setView('plan') })
    await settle()
    expect(lastRequest().view).toBe('today')
    await act(async () => { useTodos.getState().setView('starred') })
    await settle()
    expect(lastRequest().view).toBe('starred')
    await act(async () => { useTodos.getState().setView('completed') })
    await settle()
    expect(lastRequest().view).toBe('completed')
    await act(async () => { useTodos.getState().setView('list', { listId: 'L1' }) })
    await settle()
    expect(lastRequest().list).toBe('L1')
    expect(lastRequest().view).toBe('all')
    await act(async () => { useTodos.getState().setView('list', { listId: 'inbox' }) })
    await settle()
    expect(lastRequest().list).toBe('none')
    await act(async () => { useTodos.getState().setView('tag', { tagId: 'T1' }) })
    await settle()
    expect(lastRequest().tag).toBe('T1')

    expect(service.requests.length, 'the views came out of one page instead of one query each').toBeGreaterThan(before)
  })

  it('sends the search text out instead of filtering the rows it holds', async () => {
    stubBreakpoint(true)
    // The match is filed past the page a listing of the table would carry, so a filter applied to that
    // page could not have found it.
    service.rows = rows(120)
    service.hits = [task('needle', 'Feed the zebrafish', { dueAt: 1 })]
    await mount('/todo?list=L1')

    await act(async () => { useTodos.getState().setQuery('zebrafish') })
    await settle()

    expect(lastRequest().q, 'the search never left the browser').toBe('zebrafish')
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['needle'])
    expect(openIds(view!.container)).toContain('needle')
  })

  it('renders what the server returned even when the words on screen say otherwise', async () => {
    stubBreakpoint(true)
    // The server matched on something the row's title does not carry — a note, a list name, a tag. The
    // client has no way to know which, and no business second-guessing it.
    service.hits = [task('bespoke', 'Water the plants', { dueAt: 1 })]
    await mount('/todo?list=L1&q=zebrafish')
    await settle()

    expect(lastRequest().q).toBe('zebrafish')
    expect(openIds(view!.container)).toContain('bespoke')
  })

  it('starts from the address, so a shared filter goes out as parameters', async () => {
    stubBreakpoint(true)
    service.rows = rows(3, { starred: true })
    await mount('/todo?list=L1&q=tax')
    await settle()
    expect(lastRequest().list).toBe('L1')
    expect(lastRequest().q).toBe('tax')
  })

  it('asks the server for the starred rows rather than filtering the page for them', async () => {
    stubBreakpoint(true)
    service.rows = rows(5, { starred: false })
    service.hits = []
    await mount('/todo?view=starred')
    await settle()
    expect(lastRequest().view).toBe('starred')
    expect(service.requests.some((params) => (params as ListParams).view === 'open')).toBe(false)
  })
})

describe('reading past the first page', () => {
  it('appends the next page and says how many are left first', async () => {
    stubBreakpoint(true)
    service.rows = rows(130)
    await mount('/todo?list=L1')
    await settle()

    const loaded = useTodos.getState().tasks.length
    expect(loaded).toBe(PAGE_SIZE)
    expect(useTodos.getState().total).toBe(130)

    const container = view!.container
    const more = container.querySelector<HTMLButtonElement>('button[data-todo-more]')
    expect(more, 'a page that is not the whole answer leaves no way to read the rest').not.toBeNull()
    expect(more!.textContent).toContain('30')

    await act(async () => { more!.click() })
    await settle()

    expect(lastRequest().offset).toBe(loaded)
    expect(useTodos.getState().tasks).toHaveLength(130)
    // Appended, not replaced: the rows the reader was already looking at are still the ones on top.
    expect(useTodos.getState().tasks[0]!.id).toBe('t0')
    expect(useTodos.getState().tasks[129]!.id).toBe('t129')
    expect(container.querySelector('button[data-todo-more]'), 'it still offers a page that has been read').toBeNull()
  })

  it('offers nothing when the page already is the answer', async () => {
    stubBreakpoint(true)
    service.rows = rows(3)
    await mount('/todo?list=L1')
    await settle()
    expect(view!.container.querySelector('button[data-todo-more]')).toBeNull()
  })
})

describe('a search a phone can reach', () => {
  it('gives a small screen a focusable search entry that clears on Escape', async () => {
    stubBreakpoint(false)
    service.hits = rows(2)
    const container = await mount('/todo')

    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.action.search')}"]`)
    expect(toggle, 'a phone has no way to search at all').not.toBeNull()
    // A finger's height, whatever the glyph inside it is sized at.
    expect(toggle!.className).toMatch(/size-11/)

    await act(async () => { toggle!.focus() })
    expect(document.activeElement, 'the search entry is not in the keyboard order').toBe(toggle)

    await act(async () => { toggle!.click() })
    await settle()
    const input = searchField(container)
    expect(input, 'the search entry opens nothing to type into').not.toBeNull()
    expect(document.activeElement).toBe(input)

    typeInto(input!, 'zebrafish')
    await settle()
    expect(lastRequest().q).toBe('zebrafish')

    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await settle()
    expect(input!.value).toBe('')
    expect(useTodos.getState().query).toBe('')
    expect(lastRequest().q ?? '', 'clearing the text left the search in place').not.toBe('zebrafish')
  })

  it('keeps the box on a wide window and gives it no toggle', async () => {
    stubBreakpoint(true)
    const container = await mount('/todo')
    expect(container.querySelector(`button[aria-label="${t('todo.action.search')}"]`)).toBeNull()
    expect(searchField(container)).not.toBeNull()
  })
})
