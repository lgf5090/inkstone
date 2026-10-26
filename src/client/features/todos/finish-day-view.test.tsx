// @vitest-environment jsdom
/**
 * The end-of-day pass: the screen that decides what happens to what the day left behind.
 *
 * What is worth pinning here is not that four headings render. It is that the screen's gestures go
 * through the doors that already exist — the batch shelf, the plan, the status write — that each one
 * re-reads the pass afterwards, because the buckets genuinely move under the reader's hands, and that a
 * control which cannot do what it says is not drawn at all.
 *
 * The fake below derives its four buckets from one array of rows and applies every write back to it, the
 * way the endpoint does. A fake that only replayed a fixed answer would let a screen that never re-read
 * pass every case here.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { FinishDayView } from './FinishDayView'
import { readsOwnRows, useTodos } from './store'
import { surfacesFor, surfacesForPhoneMore, TODO_SURFACES } from './views/nav'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { DEFAULT_TODO_WORKDAY } from '@shared/constants'
import type { FinishDay, TaskCounts, TodoTask } from '@shared/todos/model'

const NOW = 1_700_000_000_000
const DAY = '2023-11-14'
const TOMORROW = '2023-11-15'
const DAY_MS = 86_400_000

const service = vi.hoisted(() => ({
  tasks: [] as TodoTask[],
  /** The ids the ledger holds a closed span for on the day being closed. */
  worked: [] as string[],
  /** Rows the bucket holds but the page does not carry — the answer's way of saying "there is more". */
  extra: 0,
  /** Closed spans the ledger holds for the day being closed. */
  trackedMs: 0,
  plans: [] as { id: string, date: string | null }[],
  updates: [] as { id: string, patch: Record<string, unknown> }[],
  batches: [] as { ids: string[], op: string, value?: unknown }[],
  reads: 0,
  fail: false,
}))

const overlay = vi.hoisted(() => ({ answer: true }))

const EMPTY_COUNTS: TaskCounts = {
  inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
}

/** The four buckets, derived the way the endpoint derives them, so a landed write moves the next read. */
function currentPass(): FinishDay {
  const open = (task: TodoTask) => task.status === 'todo' || task.status === 'in_progress'
  const live = service.tasks.filter((task) => task.archivedAt === null)
  return {
    day: DAY,
    tomorrow: TOMORROW,
    timezone: 'UTC',
    trackedMs: service.trackedMs,
    done: { rows: live.filter((task) => !open(task)), more: service.extra },
    worked: { rows: live.filter((task) => open(task) && service.worked.includes(task.id)), more: 0 },
    overdue: { rows: live.filter((task) => open(task) && task.dueAt !== null && task.dueAt < NOW), more: 0 },
    planned: {
      rows: live.filter((task) => open(task)
        && (task.plannedFor === TOMORROW || (task.dueAt !== null && task.dueAt >= NOW + DAY_MS && task.dueAt < NOW + DAY_MS * 2))),
      more: 0,
    },
  }
}

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      finishDay: async () => {
        service.reads += 1
        if (service.fail) throw new Error('the day could not be read')
        return currentPass()
      },
      list: async () => ({
        tasks: service.tasks.filter((task) => task.archivedAt === null),
        total: 0,
        counts: EMPTY_COUNTS,
        dayEnd: NOW + DAY_MS,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      batch: async (body: { ids: string[], op: string, value?: unknown }) => {
        service.batches.push(body)
        if (body.op === 'archive') {
          const shelved = body.value === 'true'
          service.tasks = service.tasks.map((task) => (body.ids.includes(task.id)
            ? { ...task, archivedAt: shelved ? NOW : null }
            : task))
        }
        return { done: body.ids.map((id) => ({ id, next: null })), failed: [] }
      },
      plan: async (id: string, date: string | null) => {
        service.plans.push({ id, date })
        const task = service.tasks.find((entry) => entry.id === id)
        return { task: task ? { ...task, plannedFor: date } : null }
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        service.updates.push({ id, patch })
        const task = service.tasks.find((entry) => entry.id === id)
        return { task: task ? { ...task, ...patch } : null, next: null }
      },
    },
  },
}))

// Only `confirm` is stood in for. The rest of the overlay module stays real, because the modules this
// screen drags in (the sidebar, the editors) import their dialogs from it too.
vi.mock('../../components/overlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/overlay')>()),
  confirm: async () => overlay.answer,
}))

function task(id: string, title: string, over: Partial<TodoTask> = {}): TodoTask {
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
    createdAt: NOW,
    updatedAt: NOW,
    listId: null,
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    archivedAt: null,
    ...over,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

async function open(): Promise<void> {
  view = renderElement(createElement(FinishDayView))
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function screen(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-finish-day-view]')
  if (!node) throw new Error('the end-of-day pass did not render')
  return node
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').includes(text))
}

/**
 * The session settings with one planned working day, in minutes — or `null` for "nobody planned a day".
 *
 * The pass reads the plan out of the account's settings rather than being told it, so the case has to
 * write it where the component will actually look.
 */
function patchWorkday(minutes: number | null) {
  const settings = useSession.getState().settings
  return { ...settings, todo: { ...settings.todo, workday: { ...DEFAULT_TODO_WORKDAY, dailyEstimateMinutes: minutes } } }
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** The row that names this title, so a case can talk about the buttons beside one task only. */
function rowFor(title: string): Element {
  const row = [...screen().querySelectorAll('li')].find((entry) => entry.textContent?.includes(title))
  if (!row) throw new Error(`no row was drawn for ${title}`)
  return row
}

async function takeBack(): Promise<void> {
  const undo = useTodos.getState().undo
  expect(undo, 'the write offered no way back').toBeTruthy()
  await act(async () => {
    await undo!.undo()
  })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.tasks = []
  service.worked = []
  service.extra = 0
  service.plans.length = 0
  service.updates.length = 0
  service.batches.length = 0
  service.reads = 0
  service.fail = false
  service.trackedMs = 0
  overlay.answer = true
  useSession.setState({ settings: patchWorkday(null) })
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the four things a day leaves', () => {
  it('draws one section per bucket that holds anything, from one read', async () => {
    service.tasks = [
      task('a', 'Filed the report', { status: 'done' }),
      task('b', 'Half an hour on the deck', { status: 'in_progress' }),
      task('c', 'Invoice the client', { dueAt: NOW - DAY_MS }),
      task('d', 'Plan next week', { plannedFor: TOMORROW }),
    ]
    service.worked = ['b']

    await open()

    expect(service.reads, 'the pass is read once, not once per section').toBe(1)
    for (const key of ['finished', 'touched', 'behind', 'tomorrow'] as const) {
      expect(screen().textContent, `the ${key} section is missing`).toContain(t(`todo.finish_day.${key}`))
    }
    expect(screen().textContent).not.toContain(t('todo.empty.finish_day'))
  })

  it('says so when nothing is left to decide, instead of drawing four empty frames', async () => {
    service.tasks = [task('a', 'A quiet day')]

    await open()

    expect(screen().textContent).toContain(t('todo.empty.finish_day'))
    for (const key of ['finished', 'touched', 'behind', 'tomorrow'] as const) {
      expect(screen().textContent, `an empty ${key} section was drawn`).not.toContain(t(`todo.finish_day.${key}`))
    }
  })

  it('names the rows the page could not carry', async () => {
    service.tasks = [task('a', 'One', { status: 'done' }), task('b', 'Two', { status: 'done' })]
    service.extra = 7

    await open()

    expect(screen().textContent).toContain(t('todo.finish_day.more', { count: 7 }))
    // The heading counts what the bucket holds, not what it drew: 2 on the page, 9 in the day.
    expect(screen().querySelector('h2')?.textContent).toContain('9')
  })
})

describe('filing what the day finished', () => {
  it('asks before it sweeps the bucket away, and writes nothing when the answer is no', async () => {
    service.tasks = [task('a', 'Filed the report', { status: 'done' })]
    overlay.answer = false

    await open()
    const file = buttonWith(t('todo.finish_day.file_away', { count: 1 }))
    expect(file, 'the finished section offers no way to put its rows away').toBeTruthy()
    await press(file!)

    expect(service.batches).toEqual([])
    expect(service.reads, 'a refused confirmation must not re-read the day').toBe(1)
    expect(screen().textContent).toContain('Filed the report')
  })

  it('puts the whole bucket away in one batch, and reads the day again', async () => {
    service.tasks = [
      task('a', 'Filed the report', { status: 'done' }),
      task('b', 'Closed the ticket', { status: 'cancelled' }),
      task('c', 'Still open', { status: 'in_progress' }),
    ]
    service.worked = ['c']

    await open()
    await press(buttonWith(t('todo.finish_day.file_away', { count: 2 }))!)

    // Exactly the two finished ids with `true`, and nothing about the open row drawn beside them.
    expect(service.batches).toEqual([{ ids: ['a', 'b'], op: 'archive', value: 'true' }])
    expect(service.reads, 'the buckets moved, so the pass has to be asked again').toBe(2)
    expect(screen().textContent).not.toContain('Filed the report')
    expect(screen().textContent).toContain('Still open')
  })

  it('brings the swept bucket back when the toast is taken up', async () => {
    service.tasks = [task('a', 'Filed the report', { status: 'done' })]

    await open()
    await press(buttonWith(t('todo.finish_day.file_away', { count: 1 }))!)
    await takeBack()

    expect(service.batches[1]).toEqual({ ids: ['a'], op: 'archive', value: 'false' })
    expect(screen().textContent).toContain('Filed the report')
  })
})

describe('the decisions on the rows still open', () => {
  it('moves a row into tomorrow and puts back the plan it had before', async () => {
    service.tasks = [task('a', 'Half an hour on the deck', { status: 'in_progress', plannedFor: DAY })]
    service.worked = ['a']

    await open()
    await press(buttonWith(t('todo.finish_day.to_tomorrow'))!)

    expect(service.plans).toEqual([{ id: 'a', date: TOMORROW }])
    // A pick moves the row between sections, which the screen cannot know without asking again: its rows
    // are the endpoint's buckets, not a copy it can re-sort itself.
    expect(service.reads, 'the pass was not re-read after the write landed').toBe(2)
    await takeBack()
    // Back to the day it was picked for, not to "no plan": the reader's own pick, not an approximation.
    expect(service.plans[1]).toEqual({ id: 'a', date: DAY })
  })

  it('gives a row up, and the step back restores the status it actually held', async () => {
    service.tasks = [task('a', 'Rewrite the intro', { status: 'in_progress' })]
    service.worked = ['a']

    await open()
    await press(buttonWith(t('todo.finish_day.give_up'))!)

    expect(service.updates).toEqual([{ id: 'a', patch: { status: 'cancelled' } }])
    await takeBack()
    // `in_progress`, not a hardcoded `todo`: a row that was started comes back started, or the undo has
    // quietly thrown away the one thing the reader could see about it.
    expect(service.updates[1]).toEqual({ id: 'a', patch: { status: 'in_progress' } })
  })

  it('only offers to take a row out of tomorrow when there is a pick to take back', async () => {
    service.tasks = [
      task('picked', 'Picked for tomorrow', { plannedFor: TOMORROW }),
      task('due', 'Due tomorrow', { dueAt: NOW + DAY_MS }),
    ]

    await open()

    expect(rowFor('Picked for tomorrow').textContent).toContain(t('todo.finish_day.unpick'))
    // A due date is not a pick. Clearing one would write, change nothing about when the work is owed, and
    // leave a button on the screen that had not done what it said.
    expect(rowFor('Due tomorrow').querySelectorAll('button')).toHaveLength(0)
  })
})

describe('a pass that cannot be read', () => {
  it('reports the failure with a way to try again', async () => {
    service.fail = true

    await open()

    expect(screen().querySelector('[role="alert"]')?.textContent).toBe('the day could not be read')
    expect(screen().querySelector('[role="status"]'), 'a failed read must not look like an empty day').toBeNull()

    service.fail = false
    await press(buttonWith(t('common.retry'))!)

    expect(service.reads).toBe(2)
    expect(screen().querySelector('[role="alert"]')).toBeNull()
  })
})

describe('the day against the plan', () => {
  it('prints the planned length of a day beside the hours it actually spent', async () => {
    useSession.setState({
      settings: patchWorkday(300),
    })
    service.trackedMs = 5_400_000

    await open()

    const line = screen().querySelector('[data-finish-day-spent]')
    expect(line, 'the pass drew no line about the day’s hours').toBeTruthy()
    // The two numbers the reader came here to compare: an hour and a half spent, against five planned.
    // The decimals are pinned rather than the digits alone, so a minutes/hours mix-up cannot pass by
    // printing a number that happens to contain a five.
    expect(line!.textContent).toContain('1.5')
    expect(line!.textContent).toContain('5.0')
  })

  it('draws a dash rather than a zero for a day nobody planned', async () => {
    useSession.setState({
      settings: patchWorkday(null),
    })
    service.trackedMs = 5_400_000

    await open()

    // The setting being unset is not a plan of zero minutes: `—` is the worklog's own answer to a
    // missing denominator, and `0` here would tell the reader they had nothing planned on purpose.
    expect(screen().querySelector('[data-finish-day-spent]')?.textContent).toContain('—')
  })

  it('says a day of nothing spent as nothing spent', async () => {
    useSession.setState({
      settings: patchWorkday(300),
    })

    await open()

    // The formatter rounds a small real amount up to one minute so a five-minute task does not vanish;
    // that rounding must not turn an empty day into a day that held a minute.
    expect(screen().querySelector('[data-finish-day-spent]')?.textContent).not.toMatch(/\b1\s*(min|m)\b/)
  })
})

describe('where the pass is reached from', () => {
  it('offers the sidebar row only while the account has the page switched on', () => {
    const on = surfacesFor('sidebar', { finishDayEnabled: true })
    const off = surfacesFor('sidebar', { finishDayEnabled: false })

    expect(on.map((surface) => surface.view)).toContain('finish-day')
    expect(off.map((surface) => surface.view)).not.toContain('finish-day')
    // The same offer reaches a phone: the overflow menu carries the row while the sidebar does, and
    // drops it with the sidebar row when the account switches the page off.
    expect(surfacesForPhoneMore({ finishDayEnabled: true }).map((surface) => surface.view)).toContain('finish-day')
    expect(surfacesForPhoneMore({ finishDayEnabled: false }).map((surface) => surface.view)).not.toContain('finish-day')
    // Switching the offer off does not lock the screen away: the address still names it.
    expect(TODO_SURFACES.map((surface) => surface.view)).toContain('finish-day')
  })

  it('is one of the screens that read their own rows, so the frame fetches no listing for it', () => {
    expect(readsOwnRows('finish-day')).toBe(true)
    expect(readsOwnRows('board')).toBe(false)
  })
})
