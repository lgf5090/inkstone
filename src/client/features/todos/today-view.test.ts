// @vitest-environment jsdom
/**
 * "My Day" and the plan as screens: the pick, the shift and the address reach what they name.
 *
 * The server half is pinned in `tests/todos-today.test.ts`; what this file watches is the wiring the
 * server cannot see — that typing into the picker asks for candidates, that pressing one sends the
 * task id and today's account-zone day to `POST /:id/plan`, that an overdue banner sends the due
 * batch, and that a cold `/todo?view=today` opens on the same screen a reload expects. The API is
 * stubbed at the boundary, so a picker rendered but never wired would fail here rather than pass as
 * "it looks right".
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate } from '@shared/assistant-time'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import { MAX_TASK_QUERY_CHARS } from '@shared/todos/model'

// This checkout's `node_modules` is a junction outside the Vite root, so the KaTeX stylesheet that
// the note export helpers inline is refused before a test can run. Nothing here exports a note.
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

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
  batches: [] as { ids: string[], op: string }[],
  /** The today page's rows, the open shelf the picker searches, the wider shelf a plan reads, and
   *  the overdue page the shift banner names. */
  pageRows: [] as TodoTask[],
  candidates: [] as TodoTask[],
  shelf: [] as TodoTask[],
  overdueRows: [] as TodoTask[],
  answer(params: ListParams): Record<string, unknown> {
    service.requests.push(params)
    const rows = params.q
      ? service.candidates
      : params.view === 'open'
        ? service.shelf
        : params.view === 'overdue' ? service.overdueRows : service.pageRows
    const limit = Number(params.limit ?? 0)
    const offset = Number(params.offset ?? 0)
    return {
      tasks: rows.slice(offset, offset + limit),
      total: rows.length,
      counts: { ...counts(service.pageRows.length), overdue: service.overdueRows.length },
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
      batch: async (body: { ids: string[], op: string }) => {
        service.batches.push({ ids: body.ids, op: body.op })
        return { done: body.ids, failed: [] }
      },
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'
import { groupToday, splitTodayLater } from './task-groups'

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
  service.batches.length = 0
  service.pageRows = []
  service.candidates = []
  service.overdueRows = []
  useTodos.setState(original, true)
})

afterEach(() => {
  // Unmount on the real clock: a case that faked `Date` and `setInterval` to watch the minute tick
  // must not leave React's own teardown waiting on a timer nobody will ever fire.
  vi.useRealTimers()
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

  it('suggests today’s candidates and plans each row the reader accepts', async () => {
    stubBreakpoint(true)
    const today = localDate(Date.now(), 'UTC')
    service.shelf = [
      row('overdue', 'Pay rent', { dueAt: Date.now() - 60_000 }),
      row('starred', 'Book flights', { dueAt: Date.now() + 2 * 86_400_000, starred: true }),
      row('free', 'Read the report'),
      // Already on today, finished, or in the trash: not work the plan may offer.
      row('picked', 'Already picked', { plannedFor: today }),
      row('done', 'Finished', { status: 'done' }),
      row('gone', 'Gone', { deletedAt: 123 }),
    ]

    const container = await mount('/todo?view=today')
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.today.ai_plan')}"]`)
    expect(trigger, 'the today screen offers no way to plan the shelf').not.toBeNull()
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      trigger!.click()
      await Promise.resolve()
    })
    await settle()

    // The plan reads the open shelf, not the rows already on the screen.
    expect(service.requests.some((request) => request.view === 'open' && request.limit === 200)).toBe(true)
    expect(trigger!.getAttribute('aria-expanded')).toBe('true')
    const offered = [...container.querySelectorAll<HTMLElement>('[data-today-suggestion]')]
      .map((item) => item.getAttribute('data-today-suggestion'))
    expect(offered).toEqual(['overdue', 'starred', 'free'])

    const accept = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.today.ai_plan_accept', { title: 'Pay rent' })}"]`,
    )
    expect(accept, 'an offered row has no button to accept it').not.toBeNull()
    await act(async () => {
      accept!.click()
      await Promise.resolve()
    })
    await settle()
    expect(service.plans).toEqual([{ id: 'overdue', date: today }])

    // The rest can be taken in one press, each through the same plan endpoint.
    const acceptAll = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.today.ai_plan_all')}"]`)
    expect(acceptAll, 'the panel offers no accept-all').not.toBeNull()
    await act(async () => {
      acceptAll!.click()
      await Promise.resolve()
    })
    await settle()
    expect(service.plans).toEqual([
      { id: 'overdue', date: today },
      { id: 'starred', date: today },
      { id: 'free', date: today },
    ])
    expect(container.querySelector('[data-today-suggestion]')).toBeNull()
  })

  it('shifts every overdue row to today from the banner', async () => {
    stubBreakpoint(true)
    service.overdueRows = [
      row('late-1', 'Pay rent', { dueAt: Date.now() - 86_400_000 }),
      row('late-2', 'Send invoice', { dueAt: Date.now() - 3_600_000 }),
    ]
    service.pageRows = [...service.overdueRows]

    const container = await mount('/todo?view=today')
    const shift = container.querySelector<HTMLButtonElement>('[data-todo-overdue-shift]')
    expect(shift, 'the today screen offers no overdue shift').not.toBeNull()
    // The count on the button is the count the press acts on.
    expect(shift!.textContent).toContain('2')

    await act(async () => {
      shift!.click()
      await Promise.resolve()
    })
    await settle()

    expect(service.batches).toEqual([{ ids: ['late-1', 'late-2'], op: 'due' }])
  })

  it('sends a long overdue shelf in batches of a hundred', async () => {
    stubBreakpoint(true)
    service.overdueRows = Array.from({ length: 101 }, (_, index) =>
      row(`late-${index}`, `Late ${index}`, { dueAt: Date.now() - 60_000 }))
    service.pageRows = [service.overdueRows[0]!]

    const container = await mount('/todo?view=today')
    const shift = container.querySelector<HTMLButtonElement>('[data-todo-overdue-shift]')
    expect(shift, 'the today screen offers no overdue shift').not.toBeNull()

    await act(async () => {
      shift!.click()
      await Promise.resolve()
    })
    await settle()

    // The batch route names at most a hundred rows; the second chunk carries the rest.
    expect(service.batches.map((batch) => batch.ids.length)).toEqual([100, 1])
    expect(service.batches.every((batch) => batch.op === 'due')).toBe(true)
  })

  it('names a started row that slipped past its hour in the overdue batch too', async () => {
    stubBreakpoint(true)
    // The banner's number comes from the server's overdue count and the rows it acts on come from the
    // same overdue view, which `OverdueShift` then reads once more through the open predicate before
    // naming them to the batch route. A row the reader started is owed work, so dropping it at that
    // last step would leave the toast promising to move two rows and the server moving one.
    service.overdueRows = [
      row('late-1', 'Pay rent', { dueAt: Date.now() - 86_400_000 }),
      row('late-2', 'Send invoice', { dueAt: Date.now() - 3_600_000, status: 'in_progress' }),
    ]
    service.pageRows = [...service.overdueRows]

    const container = await mount('/todo?view=today')
    const shift = container.querySelector<HTMLButtonElement>('[data-todo-overdue-shift]')
    expect(shift, 'the today screen offers no overdue shift').not.toBeNull()
    expect(shift!.textContent).toContain('2')
    // The store mirrors the page it was handed, started row included; the screen has no bucket of its
    // own to drop it into before the press ever happens.
    expect(useTodos.getState().tasks.map((task) => task.id)).toContain('late-2')

    await act(async () => {
      shift!.click()
      await Promise.resolve()
    })
    await settle()

    expect(service.batches).toEqual([{ ids: ['late-1', 'late-2'], op: 'due' }])
  })

  it('caps the picker search to the shared query bound', async () => {
    stubBreakpoint(true)
    const container = await mount('/todo?view=today')
    // The picker forwards what the reader types to the search; the server accepts at most
    // MAX_TASK_QUERY_CHARS, so the field has to bound the same way rather than let a longer word be
    // silently refused downstream.
    const field = container.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.today.pick')}"]`)
    expect(field, 'the today picker has no search field').not.toBeNull()
    expect(field!.maxLength, 'the picker search does not bound to the shared query length').toBe(MAX_TASK_QUERY_CHARS)
  })
})

describe('the plan screen', () => {
  it('puts the same overdue shift above the plan, wired to the due batch', async () => {
    stubBreakpoint(true)
    service.overdueRows = [row('late-1', 'Pay rent', { dueAt: Date.now() - 86_400_000 })]
    service.pageRows = [...service.overdueRows]

    const container = await mount('/todo?view=plan')
    // The plan divides the whole open set by when each row is owed, so it asks the server for that set
    // rather than for today's shelf; the screen it renders is still whatever the address names.
    expect(lastRequest().view).toBe('open')
    expect(useTodos.getState().view).toBe('plan')
    const shift = container.querySelector<HTMLButtonElement>('[data-todo-overdue-shift]')
    expect(shift, 'the plan screen offers no overdue shift').not.toBeNull()
    expect(shift!.textContent).toContain('1')

    await act(async () => {
      shift!.click()
      await Promise.resolve()
    })
    await settle()

    expect(service.batches).toEqual([{ ids: ['late-1'], op: 'due' }])
  })
})

describe('the later section of the today screen', () => {
  const T0 = Date.parse('2026-10-19T12:00:00Z')
  const TODAY = '2026-10-19'
  const DAY_END = Date.parse('2026-10-19T23:59:59Z')

  /**
   * Flush work on the fake clock.
   *
   * `settle` cannot be used here: its wait is itself a `setTimeout`, and under faked timers nothing
   * would ever fire it. Advancing the clock runs the pending timers and drains the microtask queue
   * between them, which is the same "the page has answered" state `settle` buys on the real clock.
   */
  async function pump(ms = 0): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    await act(async () => { await Promise.resolve() })
  }

  async function mountFake(): Promise<HTMLElement> {
    window.history.replaceState(null, '', '/todo?view=today')
    await act(async () => { view = renderElement(createElement(TodosApp)) })
    await pump()
    return view!.container
  }

  function laterSection(container: HTMLElement): HTMLElement | null {
    return container.querySelector(`section[aria-label="${t('todo.today.later')}"]`)
  }

  function laterBar(container: HTMLElement): HTMLElement | null {
    return laterSection(container)?.querySelector('button[aria-expanded]') ?? null
  }

  it('files a row owed later today in a collapsed section instead of the main list', async () => {
    vi.useFakeTimers({ now: T0 })
    stubBreakpoint(true)
    service.pageRows = [row('later', 'Call the plumber', { dueAt: T0 + 30 * 60_000 })]

    const container = await mountFake()
    const bar = laterBar(container)
    expect(bar, 'the today screen has no later section').not.toBeNull()
    expect(bar!.getAttribute('aria-expanded'), 'the later section opens expanded').toBe('false')
    expect(bar!.textContent).toContain('1')
    // The row waits behind the bar: neither in the main list nor drawn before it is asked for.
    expect(container.querySelector('[data-todo-open="later"]')).toBeNull()
  })

  it('reveals operable rows and no drag handle when the section is opened', async () => {
    vi.useFakeTimers({ now: T0 })
    stubBreakpoint(true)
    service.pageRows = [row('later', 'Call the plumber', { dueAt: T0 + 30 * 60_000 })]

    const container = await mountFake()
    const bar = laterBar(container)
    expect(bar).not.toBeNull()
    await act(async () => {
      bar!.click()
      await Promise.resolve()
    })
    expect(bar!.getAttribute('aria-expanded')).toBe('true')

    const section = laterSection(container)
    expect(section).not.toBeNull()
    expect(section!.querySelector('[data-todo-open="later"]')).not.toBeNull()
    // Operable like any other row: the finish control is there and carries its name.
    expect(section!.querySelector(`button[role="checkbox"][aria-label="${t('todo.a11y.mark_done', { title: 'Call the plumber' })}"]`)).not.toBeNull()
    // And the drag ban is visible rather than a dead gesture: a row nobody may pick up draws no
    // handle at all, so nothing on the screen promises a move the section refuses.
    expect(section!.querySelector('[data-todo-draggable]')).toBeNull()
    expect(section!.querySelector('[draggable="true"]')).toBeNull()
  })

  it('carries a row back to the main list when the minute tick passes its time', async () => {
    vi.useFakeTimers({ now: T0 })
    stubBreakpoint(true)
    service.pageRows = [row('later', 'Call the plumber', { dueAt: T0 + 30_000 })]

    const container = await mountFake()
    const bar = laterBar(container)
    expect(bar).not.toBeNull()
    await act(async () => {
      bar!.click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-todo-open="later"]')).not.toBeNull()

    // One minute of the clock, not a reload: the section recomputes itself and lets the row go.
    await pump(60_000)

    expect(laterSection(container), 'the section still holds a row whose time has come').toBeNull()
    expect(container.querySelector('[data-todo-open="later"]')).not.toBeNull()
  })

  it('keeps the planned, due-today and overdue buckets as they were', async () => {
    vi.useFakeTimers({ now: T0 })
    stubBreakpoint(true)
    service.pageRows = [
      row('picked', 'Draft the brief', { plannedFor: TODAY }),
      row('due', 'Send the invoice', { dueAt: T0 - 30 * 60_000 }),
      row('later', 'Call the plumber', { dueAt: T0 + 30 * 60_000 }),
      row('allday', 'File the return', { dueAt: Date.parse('2026-10-19T23:59:00Z') }),
      row('started', 'Write the report', { status: 'in_progress' }),
    ]

    const container = await mountFake()
    const planned = container.querySelector(`section[aria-label="${t('todo.group.planned')}"]`)
    const today = container.querySelector(`section[aria-label="${t('todo.group.today')}"]`)
    const overdue = container.querySelector(`section[aria-label="${t('todo.group.overdue')}"]`)
    expect(planned?.querySelector('[data-todo-open="picked"]')).not.toBeNull()
    expect(overdue?.querySelector('[data-todo-open="due"]')).not.toBeNull()
    expect(today?.querySelector('[data-todo-open="started"]')).not.toBeNull()
    // Only the row whose hour has not come moves; the other buckets lose nothing. A day stored at
    // the conventional 23:59 carries no hour the reader wrote, so it stays where it always was.
    expect(today?.querySelector('[data-todo-open="allday"]')).not.toBeNull()
    expect(today?.querySelector('[data-todo-open="later"]')).toBeNull()
    expect(laterBar(container)?.textContent).toContain('1')
  })

  it('splits the later rows out without touching what groupToday files where', () => {
    const rows = [
      row('picked', 'Draft the brief', { plannedFor: TODAY }),
      row('due', 'Send the invoice', { dueAt: T0 - 30 * 60_000 }),
      row('later', 'Call the plumber', { dueAt: T0 + 30 * 60_000 }),
      row('allday', 'File the return', { dueAt: Date.parse('2026-10-19T23:59:00Z') }),
      row('started', 'Write the report', { status: 'in_progress' }),
    ]
    // The three buckets and their rules are this card's untouchable ground: a row whose hour has
    // not come still reads as a today row inside groupToday, exactly as it did before the split.
    expect(groupToday(rows, { dayEnd: DAY_END, now: T0, today: TODAY })
      .map((group) => [group.key, group.tasks.map((entry) => entry.id)]))
      .toEqual([['planned', ['picked']], ['today', ['later', 'allday', 'started']], ['overdue', ['due']]])
    const split = splitTodayLater(groupToday(rows, { dayEnd: DAY_END, now: T0, today: TODAY }), { now: T0, dayEnd: DAY_END, timezone: 'UTC' })
    expect(split.groups.map((group) => [group.key, group.tasks.map((entry) => entry.id)]))
      .toEqual([['planned', ['picked']], ['today', ['allday', 'started']], ['overdue', ['due']]])
    expect(split.later.map((entry) => entry.id)).toEqual(['later'])
  })
})
