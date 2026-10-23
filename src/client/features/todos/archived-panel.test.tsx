// @vitest-environment jsdom
/**
 * The shelf screen: the rows the reader hid on purpose, and the one door back.
 *
 * The panel exists because archiving hides a row from **every** listing, the completed list included —
 * a shelf nobody can look at again is a deletion the reader cannot see coming. So the case that matters
 * here is not that the page renders but that it reads the same predicate the rest of the app reads
 * (`archived=1`, asked as its own page rather than filtered out of a normal listing the panel would then
 * be lying about), and that taking a row down goes through the door that stamps the column rather than a
 * second write this page invented.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ArchivedPanel } from './ArchivedPanel'
import { useTodos } from './store'
import { SHELF_PAGE_SIZE, type TaskCounts, type TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  tasks: [] as TodoTask[],
  /** Every shelf request, in the order the screen made them. */
  requests: [] as Record<string, unknown>[],
  batches: [] as { ids: string[], op: string, value?: unknown }[],
  /** When set, a batch waits on it: how the in-flight case holds the answer without replacing the door. */
  holdBatch: null as Promise<void> | null,
}))

const EMPTY_COUNTS: TaskCounts = {
  inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
}

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async (params: Record<string, unknown> = {}) => {
        service.requests.push(params)
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 100)
        // One array of every row, two readings of it: the shelf and the ordinary listing are the same
        // predicate seen from either side, which is the property this panel exists to hold.
        const tasks = params.archived === '1'
          ? service.tasks.filter((entry) => entry.archivedAt != null)
          : service.tasks.filter((entry) => entry.archivedAt == null)
        return { tasks: tasks.slice(offset, offset + limit), total: tasks.length, counts: EMPTY_COUNTS, dayEnd: Date.now() + 86_400_000, timezone: 'UTC' }
      },
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      batch: async (body: { ids: string[], op: string, value?: unknown }) => {
        service.batches.push(body)
        // Held: the row stays on the page with its button switched off, which is the state the case
        // below is about. Released: the fake answers the way the server does, by clearing the stamp.
        if (service.holdBatch) await service.holdBatch
        for (const id of body.ids)
          service.tasks = service.tasks.map((entry) => (entry.id === id ? { ...entry, archivedAt: null } : entry))
        return { done: body.ids.map((id) => ({ id, next: null })), failed: [] }
      },
    },
  },
}))

function row(id: string, title: string, archivedAt: number): TodoTask {
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
    createdAt: archivedAt,
    updatedAt: archivedAt,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    archivedAt,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

async function open(): Promise<void> {
  view = renderElement(createElement(ArchivedPanel, { open: true, onClose: () => {} }))
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-todo-shelf-row]')]
}

function buttonNamed(fragment: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent ?? '').includes(fragment))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.tasks = []
  service.requests.length = 0
  service.batches.length = 0
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the shelf panel', () => {
  it('asks for the shelf by name rather than filtering a normal listing down', async () => {
    service.tasks = [row('a', 'Renew the licence', 1_700_000_000_000)]

    await open()

    // `view=all&archived=1` is the other side of the one visibility rule; a listing the panel then
    // trimmed by hand would be a second answer about what the reader put away.
    expect(service.requests[0]).toMatchObject({ view: 'all', archived: '1', limit: SHELF_PAGE_SIZE })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain('Renew the licence')
    // The stamp the row carries is the answer to "when did I put this away", which is the only context
    // that makes a shelf readable once it holds more than a couple of rows.
    expect(rows()[0]?.textContent).toContain('Archived ')
  })

  it('says so when the shelf is empty, rather than showing a blank page', async () => {
    await open()

    expect(rows()).toHaveLength(0)
    expect(document.querySelector('[role="status"]')?.textContent).toBe(t('todo.shelf.empty'))
  })

  it('takes one row down through the door that stamps the column, and drops it from the page', async () => {
    service.tasks = [row('a', 'Renew the licence', 1_700_000_000_000), row('b', 'Old quarter', 1_700_000_000_000)]

    await open()
    expect(rows()).toHaveLength(2)

    const take = buttonNamed(t('todo.shelf.take_down'))
    expect(take, 'the row offers no way back').toBeTruthy()
    await act(async () => {
      take!.click()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    // One row, named value: `false` is the answer that clears the stamp, and an omitted value would let
    // the route's own default decide what the button meant.
    expect(service.batches).toEqual([{ ids: ['a'], op: 'archive', value: 'false' }])
    expect(rows().map((entry) => entry.textContent?.slice(0, 11))).toEqual(['Old quarter'])
    // The row that came back is in the listing behind the panel, not only in this page's copy of it.
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['a'])
  })

  it('disables the row while its request is in flight, so one press cannot become two', async () => {
    service.tasks = [row('a', 'Renew the licence', 1_700_000_000_000)]
    let release: () => void = () => {}
    service.holdBatch = new Promise<void>((resolve) => { release = resolve })

    await open()

    const take = buttonNamed(t('todo.shelf.take_down'))!
    act(() => { take.click() })
    expect(service.batches).toHaveLength(1)
    expect(buttonNamed(t('todo.shelf.take_down'))?.disabled).toBe(true)

    await act(async () => {
      release()
      await service.holdBatch
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    service.holdBatch = null

    expect(rows()).toHaveLength(0)
    expect(service.batches).toHaveLength(1)
  })
})
