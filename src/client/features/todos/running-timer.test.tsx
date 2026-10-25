// @vitest-environment jsdom
/**
 * The one timer, shown everywhere.
 *
 * "What am I working on, and for how long" is a question that outlives the screen it was started on: a
 * reader switches to the calendar, to the statistics, to another tab entirely, and the interval keeps
 * running. So the row that answers it sits in the app's frame rather than inside any view, and these
 * cases pin the three things that make it a clock rather than a decoration.
 *
 * It reads from the ledger's own derived field, not from a second piece of state: `runningSince` is
 * what the server says is open, and a bar with its own idea of "which task is running" is a second
 * truth about an account the database already guarantees is holding one interval.
 *
 * The number is interpolated locally off `performance.now()`, and that is the load-bearing part. A
 * wall-clock difference is what the display would jump on the first system clock correction, and a
 * per-second poll of the server would be a hundred requests an hour for a number that is already
 * known. `role="timer"` and no live region is the other half: a counter that announced itself every
 * second would make the rest of the screen unreadable.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({ reads: [] as string[] }))

vi.mock('../../lib/api', () => {
  const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
  return {
    api: {
      todos: {
        list: async () => ({ tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
        get: async (id: string) => {
          service.reads.push(id)
          return { task: null, steps: [] }
        },
      },
    },
  }
})

import { RunningTimerBar } from './running-timer'
import { useTodos } from './store'

const MINUTE = 60_000
/** 09:00 on the day the cases are written against. */
const NOW = Date.parse('2026-10-20T09:00:00Z')
/** The interval half an hour long that the mounted row is running. */
const STARTED = NOW - 30 * MINUTE

let perfNow = 1_000
const original = useTodos.getState()
let view: RenderedElement | null = null

function timedTask(extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id: 'a',
    title: 'Write the report',
    description: '',
    status: 'in_progress',
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
    runningSince: STARTED,
    ...extra,
  }
}

/** Advance the monotonic clock the bar counts on, without moving anything else. */
function advanceMonotonic(ms: number): void {
  perfNow += ms
}

function mount(): void {
  view = renderElement(createElement(RunningTimerBar))
}

function elapsed(): HTMLElement {
  const counter = view!.container.querySelector<HTMLElement>('[data-todo-running-elapsed]')
  if (!counter) throw new Error('the running bar shows no counter')
  return counter
}

function openControl(): HTMLButtonElement {
  const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-running-open]')
  if (!button) throw new Error('the running bar is not pressable')
  return button
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.reads.length = 0
  perfNow = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => perfNow)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.useFakeTimers({ toFake: ['setInterval'] })
  useTodos.setState(original, true)
  useTodos.setState({ status: 'ready', tasks: [timedTask()], completed: [], total: 1, timezone: 'UTC' })
  window.history.replaceState(null, '', '/todo')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the bar that follows the running interval', () => {
  it('is not drawn at all when nothing is being timed', () => {
    useTodos.setState({ tasks: [timedTask({ runningSince: null })] })
    mount()
    expect(view!.container.querySelector('[data-todo-running-bar]')).toBeNull()
  })

  it('names the task and the time it has been running', () => {
    mount()
    expect(view!.container.querySelector('[data-todo-running-bar]')).not.toBeNull()
    expect(openControl().textContent).toContain('Write the report')
    expect(elapsed().textContent).toBe('30:00')
  })

  it('counts on the monotonic clock between the ticks', () => {
    mount()
    advanceMonotonic(90_000)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(elapsed().textContent).toBe('31:30')
  })

  it('does not jump when the wall clock is corrected under it', () => {
    mount()
    advanceMonotonic(20_000)
    // A system clock put back an hour while the interval runs: a `Date.now()` difference would answer
    // with a negative number clamped to zero, and a running timer that reads 0:00 says the work stopped.
    vi.spyOn(Date, 'now').mockReturnValue(NOW - 3_600_000)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(elapsed().textContent).toBe('30:20')
  })

  it('catches up on the tab returning, without restarting the count', () => {
    mount()
    // The throttled interval never fired while the tab was hidden; the clock the bar counts on did run.
    advanceMonotonic(45_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(elapsed().textContent).toBe('30:45')
  })

  it('re-anchors when the ledger says a different instant began the run', () => {
    mount()
    advanceMonotonic(60_000)
    act(() => {
      useTodos.setState({ tasks: [timedTask({ runningSince: NOW - 5 * MINUTE })] })
    })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(elapsed().textContent).toBe('05:00')
  })

  it('presses through to the task it names', async () => {
    mount()
    await act(async () => {
      openControl().click()
      await Promise.resolve()
    })
    // Reaching the task, not opening a second copy of the bar: the store's one door by id is what a
    // cross-view indicator is allowed to use, and it works for a row the current page never read.
    expect(useTodos.getState().selectedId).toBe('a')
    expect(window.location.pathname).toBe('/todo/a')
  })

  it('says what it is to a reader who cannot see the tint', () => {
    mount()
    expect(elapsed().getAttribute('role')).toBe('timer')
    expect(openControl().getAttribute('aria-label')).toBe(t('todo.timer.running_aria', { title: 'Write the report' }))
  })

  it('prints past an hour with the hour in front', () => {
    useTodos.setState({ tasks: [timedTask({ runningSince: NOW - (75 * MINUTE + 5_000) })] })
    mount()
    expect(elapsed().textContent).toBe('1:15:05')
  })
})
