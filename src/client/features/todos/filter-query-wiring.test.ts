// @vitest-environment jsdom
/**
 * The search box as a filter-line reader.
 *
 * The box used to hand its whole text to the route's `q`, so `list:Work` was searched for as those
 * eleven characters rather than narrowing the list. These cases hold the line at the API boundary:
 * what the line was read as, what the route was asked, and what the address kept. The last cases pin
 * the one condition the route cannot express — a negated tag — and the page arithmetic that keeps a
 * hidden row from making the next page skip a row.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

interface ListParams {
  view?: string
  list?: string
  tag?: string
  q?: string
  status?: string
  priority?: string
  starred?: string
  dueFrom?: string
  dueTo?: string
  limit?: number
  offset?: number
}

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

const service = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  rows: [] as TodoTask[],
  lists: [
    { id: 'L1', name: 'Work', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 },
    { id: 'L2', name: 'Home', icon: null, color: null, position: 1, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 },
  ],
  tags: [
    { id: 'T1', name: 'urgent', color: null, createdAt: 0, updatedAt: 0, openCount: 0 },
    { id: 'T2', name: 'home', color: null, createdAt: 0, updatedAt: 0, openCount: 0 },
  ],
  answer(params: Record<string, unknown>): Record<string, unknown> {
    service.requests.push(params)
    const limit = Number(params.limit ?? 0)
    const offset = Number(params.offset ?? 0)
    return {
      tasks: service.rows.slice(offset, offset + limit),
      total: service.rows.length,
      counts: EMPTY_COUNTS,
      dayEnd: Date.now() + 3_600_000,
      timezone: 'UTC',
    }
  },
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async (params: Record<string, unknown> = {}) => service.answer(params),
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: service.tags }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'

/** A row the way the route serialises one, carrying the tags a case needs to see excluded. */
function task(id: string, title: string, tags: TodoTask['tags'] = []): TodoTask {
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
    listId: 'L2',
    tags,
    starred: false,
    repeat: null,
    remindedAt: null,
    noteId: null,
    conversationId: null,
    stepTotal: 0,
    stepDone: 0,
  } as unknown as TodoTask
}

function tag(id: string, name: string): TodoTask['tags'][number] {
  return { id, name, color: null, createdAt: 0, updatedAt: 0, openCount: 0 }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 320)) })
  await act(async () => { await Promise.resolve() })
}

async function mount(address: string): Promise<HTMLElement> {
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

function searchField(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label]')
  if (!input) throw new Error('the search box is not rendered')
  return input
}

function lastRequest(): ListParams {
  return service.requests.at(-1) as ListParams
}

function openIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-todo-open]')].map((node) => node.getAttribute('data-todo-open') ?? '')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.requests.length = 0
  service.rows = [task('r1', 'Write report')]
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

describe('the search box reads the filter line', () => {
  it('sends every qualifier to the route as its own parameter', async () => {
    stubBreakpoint(true)
    // The screen is a list of Home; the line names Work, which has to win over the view's collection.
    const container = await mount('/todo?list=L2')
    const line = 'list:Work tag:urgent p:1 starred:true status:todo,in_progress due:2026-10-01..2026-10-31 report'
    typeInto(searchField(container), line)
    await settle()

    expect(lastRequest()).toMatchObject({
      list: 'L1',
      tag: 'T1',
      priority: 'low',
      starred: '1',
      status: 'todo,in_progress',
      dueFrom: '2026-10-01T00:00',
      dueTo: '2026-11-01T00:00',
      q: 'report',
    })
    // The address keeps what was typed, not the parameters it was read into.
    expect(new URLSearchParams(window.location.search).get('q')).toBe(line)
    expect(useTodos.getState().query).toBe(line)
  })

  it('reads a named list on a cold load, before the listing is asked for', async () => {
    stubBreakpoint(true)
    // No list has been read yet, so the name can only be resolved by reading the directory first.
    await mount('/todo?q=list:Work')
    expect(lastRequest().list).toBe('L1')
  })

  it('leaves a word it cannot read in the search text instead of dropping it', async () => {
    stubBreakpoint(true)
    const container = await mount('/todo?list=L2')
    typeInto(searchField(container), 'p:9 report')
    await settle()

    expect(lastRequest().priority).toBeUndefined()
    expect(lastRequest().q).toBe('p:9 report')
  })
})

describe('a negated tag', () => {
  it('hides the fetched rows that carry it, because the route has no exclusion', async () => {
    stubBreakpoint(true)
    service.rows = [task('keep', 'Keep me', [tag('T3', 'work')]), task('drop', 'Drop me', [tag('T2', 'home')])]
    const container = await mount('/todo?list=L2')
    expect(openIds(container)).toEqual(['keep', 'drop'])

    typeInto(searchField(container), '-tag:home')
    await settle()

    expect(lastRequest().tag).toBeUndefined()
    expect(lastRequest().q).toBeUndefined()
    expect(openIds(container)).toEqual(['keep'])
  })

  it('asks for the next page by the rows the server sent, not the rows left visible', async () => {
    stubBreakpoint(true)
    // Every tenth row carries the tag, so the first page arrives with ten rows hidden and the offset
    // the reader's scroll should resume from is still a hundred.
    service.rows = Array.from({ length: 130 }, (_unused, index) =>
      task(`t${index}`, `Task ${index}`, index % 10 === 0 ? [tag('T2', 'home')] : []))
    const container = await mount('/todo?list=L2')

    typeInto(searchField(container), '-tag:home')
    await settle()

    expect(useTodos.getState().tasks).toHaveLength(90)
    const more = container.querySelector<HTMLButtonElement>('button[data-todo-more]')
    expect(more, 'a page with hidden rows leaves no way to read the rest').not.toBeNull()
    expect(more!.textContent).toContain('30')

    await act(async () => { more!.click() })
    await settle()

    expect(lastRequest().offset).toBe(100)
    expect(useTodos.getState().tasks).toHaveLength(117)
    expect(container.querySelector('button[data-todo-more]')).toBeNull()
  })
})
