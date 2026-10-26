// @vitest-environment jsdom
/**
 * The focus overlay: what it keeps running, and what it refuses to stop.
 *
 * The card's whole reason to exist is the C9 rule, so most of what is pinned here is about a keystroke.
 * `Esc` takes the panel off the screen and leaves the session — the interval, the block, the countdown —
 * running, because the classic one-star review of every focus timer is the reader who lost a twenty-five
 * minute block to a reflexive Escape. Stopping the clock is a different gesture with a different name, and
 * it asks first. Both halves are asserted at the API boundary rather than inside the component: what a
 * reader means by "it is still running" is that the ledger is still open and the number is still moving.
 *
 * The rest is the three things the plan names as easy to get wrong and hard to see: whether a break costs
 * the task time (`pauseTrackingDuringBreak`, both states), whether the clock speaks once a minute rather
 * than once a second, and whether a page without Web Audio still gets a session that runs to its end
 * rather than an exception.
 *
 * The keyboard cases borrow the shape the shortcut suite uses — an `article` with a checkbox beside the
 * body that carries the task's id — because that is the row contract `f` reads, and a harness that drew
 * rows some other way would be testing a shape the app does not have.
 */
import { act, createElement, Fragment, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { ConfirmHost, PromptHost } from '../../components/overlay'
import { DEFAULT_SETTINGS, DEFAULT_TODO_FOCUS } from '@shared/constants'
import type { TodoFocusSettings } from '@shared/types'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

const server = vi.hoisted(() => ({
  rows: [] as TodoTask[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  timerStarts: [] as string[],
  timerStops: [] as string[],
}))

const counts: TaskCounts = {
  inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
  completed: 0, starred: 0, byList: {}, byTag: {},
}

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {
    code = 'internal'
  },
  CLIENT_ID: 'test-client',
  api: {
    settings: { save: async (body: unknown) => ({ settings: body }) },
    todos: {
      list: async () => ({
        tasks: server.rows,
        total: server.rows.length,
        counts: { ...counts, all: server.rows.length },
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      counts: async () => ({ counts }),
      get: async (id: string) => ({ task: server.rows.find((entry) => entry.id === id) ?? null, steps: [] }),
      update: async (id: string, patch: Record<string, unknown>) => {
        server.updates.push({ id, patch })
        const index = server.rows.findIndex((entry) => entry.id === id)
        const before = server.rows.find((entry) => entry.id === id)!
        const task = { ...before, ...patch, updatedAt: Date.now() } as TodoTask
        if (index >= 0) server.rows[index] = task
        return { task, next: null }
      },
      startTimer: async (id: string) => {
        server.timerStarts.push(id)
        const row = server.rows.find((entry) => entry.id === id)!
        row.runningSince = Date.now()
        return { entry: { id: 'entry-1', taskId: id, startAt: Date.now(), endAt: null, day: '2026-10-20', source: 'focus' } }
      },
      stopTimer: async (id: string) => {
        server.timerStops.push(id)
        const row = server.rows.find((entry) => entry.id === id)!
        row.runningSince = null
        return { entries: [] }
      },
    },
  },
}))

import { useSession } from '../../store/session'
import { useTodos } from './store'
import { TodosApp } from './TodosApp'
import { FocusLayer } from './FocusOverlay'
import { useFocusSession } from './focus-session'
import { useTodoShortcuts } from './use-todo-shortcuts'

const MINUTE = 60_000
/** 09:00 on the day the cases are written against. */
const NOW = Date.parse('2026-10-20T09:00:00Z')
/** The monotonic clock the session counts on, moved by hand so a case says what time passed. */
let perfNow = 1_000

let view: RenderedElement | null = null
const originalTodos = useTodos.getState()

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: `task ${id}`,
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
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    runningSince: null,
    timeEstimateMs: null,
    timeSpentMs: 0,
    ...extra,
  }
}

/** Hand the account one focus subgroup, leaving every other setting where the defaults put it. */
function focusSettings(patch: Partial<TodoFocusSettings> = {}): void {
  useSession.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      todo: { ...DEFAULT_SETTINGS.todo, focus: { ...DEFAULT_TODO_FOCUS, ...patch } },
    },
  })
}

/** Move the session's clock and let every tick in between run. */
function advance(ms: number): void {
  perfNow += ms
  act(() => { vi.advanceTimersByTime(ms) })
}

function layerTree(): ReturnType<typeof createElement> {
  return createElement(Fragment, null, [
    createElement(FocusLayer, { key: 'layer' }),
    createElement(ConfirmHost, { key: 'confirm-host' }),
    createElement(PromptHost, { key: 'prompt-host' }),
  ])
}

function mount(): void {
  view = renderElement(layerTree())
}

/** Put a session on the row, the way a key press would, and let the panel mount around it. */
function openFocus(taskId = 'a'): void {
  act(() => { useFocusSession.getState().open(taskId) })
}

/** The container reduced to what the keyboard layer reads: one real row, and the layer beside it. */
function Harness() {
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useTodoShortcuts({
    contentRef,
    searchRef,
    wide: true,
    searchOpen: false,
    page: 'main',
    openSearch: () => {},
    closeSearch: () => {},
    toggleSidebar: () => {},
    newTask: () => {},
    goMain: () => {},
  })
  return createElement('div', {}, [
    createElement('div', { key: 'rows', ref: contentRef }, server.rows.map((entry) => createElement('article', { key: entry.id }, [
      createElement('button', { key: 'box', type: 'button', 'aria-label': `tick ${entry.id}` }),
      createElement('button', { key: 'body', type: 'button', 'data-todo-open': entry.id }, entry.title),
    ]))),
    createElement('input', { key: 'search', ref: searchRef, 'aria-label': 'the search field' }),
  ])
}

function mountKeyboard(): void {
  view = renderElement(createElement('div', {}, [
    createElement(Harness, { key: 'frame' }),
    createElement('div', { key: 'focus-layer' }, layerTree()),
  ]))
}

function setState(): void {
  useTodos.setState({
    status: 'ready',
    tasks: server.rows,
    completed: [],
    total: server.rows.length,
    fetched: server.rows.length,
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + 86_400_000,
    selectedIds: new Set<string>(),
  })
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-focus-overlay]')
}

function screenName(): string | null {
  return overlay()?.getAttribute('data-focus-screen') ?? null
}

function clockText(): string {
  const node = document.querySelector<HTMLElement>('[data-focus-clock-text]')
  if (!node) throw new Error('the overlay draws no clock')
  return node.textContent ?? ''
}

function spoken(): string {
  const node = document.querySelector<HTMLElement>('[data-focus-clock-spoken]')
  if (!node) throw new Error('the clock has nothing to say')
  return node.textContent ?? ''
}

/** Press a control by the name a reader is told it has. */
async function press(name: string): Promise<void> {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
    const label = button.getAttribute('aria-label') ?? button.textContent ?? ''
    return label.includes(name)
  })
  if (!node) throw new Error(`no control is named “${name}”`)
  await act(async () => {
    node.click()
    await Promise.resolve()
  })
}

function starts(): number {
  return server.timerStarts.length
}

function stops(): number {
  return server.timerStops.length
}

/** The dialog the app's own `confirm()` drew, found by the question it asks. */
function confirmPanel(): HTMLElement {
  const panel = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((node) => (node.textContent ?? '').includes(t('todo.focus.cancel_title')))
  if (!panel) throw new Error('the cancel question is not on screen')
  return panel
}

async function clickIn(panel: HTMLElement, name: string): Promise<void> {
  const node = [...panel.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => (button.textContent ?? '').includes(name))
  if (!node) throw new Error(`the panel holds no button called “${name}”`)
  await act(async () => {
    node.click()
    await Promise.resolve()
  })
}

function pressKey(key: string, target?: EventTarget): void {
  const node = target ?? document.activeElement ?? document.body
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

/** Type into a field the way typing would, and let the component's own state land. */
async function typeInto(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

function titleInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-focus-title-input]')
}

beforeEach(async () => {
  localStorage.clear()
  server.rows = [task('a', { title: 'Write the report' })]
  server.updates = []
  server.timerStarts = []
  server.timerStops = []
  perfNow = 1_000
  await initI18n()
  vi.spyOn(performance, 'now').mockImplementation(() => perfNow)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout'] })
  focusSettings()
  useTodos.setState(originalTodos, true)
  setState()
  window.history.replaceState({}, '', '/todo')
  useFocusSession.getState().endSession()
})

afterEach(() => {
  // The reader leaving the session is a gesture the surface already has; a reset written for the suite
  // would be an action no product path ever takes.
  useFocusSession.getState().endSession()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(originalTodos, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('opening the overlay', () => {
  it('takes the row the f key was pressed at, and starts nothing yet', async () => {
    server.rows = [task('a', { title: 'Write the report', timeEstimateMs: 45 * MINUTE, timeSpentMs: 20 * MINUTE + 30_000 })]
    setState()
    mountKeyboard()
    await flush()
    act(() => { document.querySelector<HTMLElement>('[data-todo-open="a"]')?.focus() })
    pressKey('f')

    expect(overlay(), 'the f key did not open the focus overlay').not.toBeNull()
    expect(screenName()).toBe('main')
    expect(overlay()!.textContent).toContain('Write the report')
    // The block is what the estimate still leaves — twenty-four and a half minutes — floored, not rounded.
    expect(clockText()).toBe('24:00')
    expect(starts()).toBe(0)
  })

  it('mounts beside the frame, so a session opened anywhere reaches the screen', async () => {
    stubBreakpoint(true)
    view = renderElement(createElement(TodosApp))
    await flush()
    openFocus()
    await flush()
    expect(overlay(), 'the container draws no focus layer').not.toBeNull()
  })

  it('takes the ledger the moment the reader presses start, and counts from there', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))

    expect(server.timerStarts).toEqual(['a'])
    advance(61_000)
    expect(clockText()).toBe('08:59')
  })

  it('leaves a row key to the panel that owns the screen', async () => {
    mountKeyboard()
    await flush()
    act(() => { document.querySelector<HTMLElement>('[data-todo-open="a"]')?.focus() })
    pressKey('f')
    server.updates = []
    pressKey('d')

    // `d` would finish the row behind the panel. The frame's own guard is what stops it, and the panel
    // is what the guard reads.
    expect(server.updates).toEqual([])
    expect(overlay()).not.toBeNull()
  })

  it('re-plans the block when the reader picks another strategy', async () => {
    focusSettings({ pomodoro: { work: 18, short: 4, long: 20, every: 3 } })
    mount()
    openFocus()
    await flush()
    await press(t('settings.todo_focus_strategy_pomodoro'))

    expect(clockText()).toBe('18:00')
    expect(useFocusSession.getState().session?.strategy).toBe('pomodoro')
  })
})

describe('Escape leaves the session running (C9)', () => {
  it('takes the panel off the screen without touching the interval', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(30_000)
    escapeAway()

    expect(overlay()).toBeNull()
    expect(document.querySelector('[data-focus-bar]'), 'the frame took over no countdown').not.toBeNull()
    expect(stops(), 'Escape stopped the timer').toBe(0)
    expect(starts()).toBe(1)
    expect(useFocusSession.getState().session?.taskId).toBe('a')
  })

  it('keeps counting while the panel is away, and hands the same block back', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    escapeAway()

    // The number the strip shows is still moving: a hidden session that froze would be the defect.
    advance(2 * MINUTE)
    expect(document.querySelector<HTMLElement>('[data-focus-bar-clock]')?.textContent).toBe('08:00')

    await press(t('todo.focus.hidden_aria', { title: 'Write the report' }))
    expect(overlay()).not.toBeNull()
    expect(clockText()).toBe('08:00')
    expect(stops()).toBe(0)
  })

  it('swallows the Escape that cancels a title edit', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.edit_title'))
    const field = titleInput()
    expect(field).not.toBeNull()

    act(() => {
      field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    expect(overlay(), 'the panel closed on an Escape meant for the field').not.toBeNull()
    expect(document.querySelector('[data-focus-bar]')).toBeNull()
    expect(titleInput()).toBeNull()
  })

  it('asks for a real decision before it stops anything', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    await press(t('todo.focus.cancel'))

    expect(confirmPanel(), 'the cancel gesture did not ask').not.toBeNull()
    expect(stops()).toBe(0)
    expect(overlay()).not.toBeNull()

    await clickIn(confirmPanel(), t('common.cancel'))
    expect(stops()).toBe(0)
    expect(overlay()).not.toBeNull()
    expect(useFocusSession.getState().session?.taskId).toBe('a')
  })

  it('stops the interval only on the answer that says so', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    await press(t('todo.focus.cancel'))
    await clickIn(confirmPanel(), t('todo.focus.cancel'))

    expect(server.timerStops).toEqual(['a'])
    expect(overlay()).toBeNull()
    expect(document.querySelector('[data-focus-bar]')).toBeNull()
    expect(useFocusSession.getState().session).toBeNull()
  })
})

/** The keystroke C9 is about, sent the way the browser would send it. */
function escapeAway(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

describe('breaks and what they cost the ledger', () => {
  beforeEach(() => {
    focusSettings({
      strategy: 'pomodoro',
      pomodoro: { work: 2, short: 1, long: 5, every: 2 },
      pauseTrackingDuringBreak: true,
    })
  })

  it('ends a work block on its own clock and names the break that follows', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(2 * MINUTE)

    expect(screenName()).toBe('session-done')
    // The block is over, so its interval is filed: that is the whole of "a break costs nothing".
    expect(stops()).toBe(1)
    expect(overlay()!.textContent).toContain(t('todo.focus.break_start'))
  })

  it('keeps the ledger closed across a break when tracking is paused', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(2 * MINUTE)
    await press(t('todo.focus.break_start'))

    expect(screenName()).toBe('break')
    expect(stops()).toBe(1)
    expect(starts(), 'the break reopened the ledger').toBe(1)

    advance(1 * MINUTE)
    expect(screenName()).toBe('main')
    // The next block is a new interval, opened after the break and not during it.
    expect(starts()).toBe(2)
    expect(stops()).toBe(1)
  })

  it('lets the worklog run straight through a break when tracking is not paused', async () => {
    focusSettings({
      strategy: 'pomodoro',
      pomodoro: { work: 2, short: 1, long: 5, every: 2 },
      pauseTrackingDuringBreak: false,
    })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(2 * MINUTE)

    expect(screenName()).toBe('session-done')
    expect(stops(), 'a block ending closed an interval the reader chose to keep running').toBe(0)

    await press(t('todo.focus.break_start'))
    expect(screenName()).toBe('break')
    advance(1 * MINUTE)
    expect(screenName()).toBe('main')
    expect(starts()).toBe(1)
    expect(stops()).toBe(0)
  })

  it('brings the next block forward when the break is skipped', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(2 * MINUTE)
    await press(t('todo.focus.break_start'))
    await press(t('todo.focus.break_skip'))

    expect(screenName()).toBe('main')
    expect(starts()).toBe(2)
  })

  it('counts the long break only at the round the settings name', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    // Round one of two: the short break is what is on offer.
    advance(2 * MINUTE)
    expect(document.querySelector<HTMLElement>('[data-focus-next-break]')?.textContent).toBe('01:00')
    await press(t('todo.focus.break_start'))
    advance(1 * MINUTE)
    // Round two of two: the long one, at the round `every` names.
    advance(2 * MINUTE)
    expect(screenName()).toBe('session-done')
    expect(document.querySelector<HTMLElement>('[data-focus-next-break]')?.textContent).toBe('05:00')
    expect(overlay()!.textContent).toContain(t('todo.focus.round', { round: 2 }))
  })
})

describe('flowtime', () => {
  it('counts up with no plan, and suggests a break only once one is owed', async () => {
    focusSettings({ strategy: 'flowtime', flowtime: { breakEnabled: true, breakPercentage: 20 } })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    expect(clockText()).toBe('00:00')

    advance(4 * MINUTE)
    expect(document.querySelector('[data-focus-suggest-break]')).toBeNull()

    advance(60_000)
    expect(document.querySelector<HTMLElement>('[data-focus-suggest-break]'),
      'a fifth of five minutes was not enough to say anything').not.toBeNull()

    await press(t('todo.focus.break_start'))
    expect(screenName()).toBe('break')
    expect(clockText()).toBe('01:00')
  })

  it('says nothing about a break when the reader switched the suggestion off', async () => {
    focusSettings({ strategy: 'flowtime', flowtime: { breakEnabled: false, breakPercentage: 20 } })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(30 * MINUTE)
    expect(document.querySelector('[data-focus-suggest-break]')).toBeNull()
  })
})

describe('the clock as a thing a screen reader can use', () => {
  it('is a timer that speaks a whole minute at a time', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))

    const face = document.querySelector<HTMLElement>('[data-focus-clock]')
    expect(face?.getAttribute('role')).toBe('timer')
    expect(face?.getAttribute('aria-live')).toBe('polite')
    expect(spoken()).toBe(t('todo.focus.spoken_left', { minutes: 10 }))

    // Half a minute of seconds must not buy half a minute of announcements.
    advance(30_000)
    expect(spoken()).toBe(t('todo.focus.spoken_left', { minutes: 10 }))
    advance(31_000)
    expect(spoken()).toBe(t('todo.focus.spoken_left', { minutes: 9 }))
  })
})

describe('the task row inside the overlay', () => {
  it('writes a title typed into it through the store’s own door', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.edit_title'))
    const field = titleInput()
    expect(field).not.toBeNull()
    await typeInto(field!, 'Write the real report')
    act(() => {
      field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()

    expect(server.updates.at(-1)?.patch).toEqual({ title: 'Write the real report' })
    expect(overlay()!.textContent).toContain('Write the real report')
  })

  it('nudges the block by five minutes either way, and holds to the edges', async () => {
    focusSettings({ defaultMinutes: 25 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.nudge_longer', { minutes: 5 }))
    expect(clockText()).toBe('30:00')
    await press(t('todo.focus.nudge_shorter', { minutes: 5 }))
    await press(t('todo.focus.nudge_shorter', { minutes: 5 }))
    expect(clockText()).toBe('20:00')

    for (let step = 0; step < 45; step += 1) await press(t('todo.focus.nudge_longer', { minutes: 5 }))
    // Four hours is the ceiling the settings hold, and the stopwatch prints it the way it prints any
    // length past an hour — the clock and the row never had two formats to disagree about.
    expect(clockText()).toBe('4:00:00')
  })

  it('files a note written into the app’s own prompt', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.note'))
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')
    expect(field, 'no prompt opened for the note').not.toBeNull()
    await typeInto(field!, 'numbers are in the spreadsheet')
    act(() => {
      field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()

    expect(server.updates.at(-1)?.patch).toEqual({ description: 'numbers are in the spreadsheet' })
  })

  it('marks the task done and files the interval with it', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(60_000)
    await press(t('todo.focus.finish'))
    expect(screenName()).toBe('session-done')

    await press(t('todo.focus.mark_done'))
    expect(server.timerStops).toEqual(['a'])
    expect(server.updates.some((entry) => entry.patch.status === 'done')).toBe(true)
    expect(useFocusSession.getState().session).toBeNull()
  })

  it('restarts the block without leaving the screen it is on', async () => {
    focusSettings({ defaultMinutes: 10 })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(3 * MINUTE)
    await press(t('todo.focus.restart'))

    expect(clockText()).toBe('10:00')
    expect(screenName()).toBe('main')
  })
})

describe('what the overlay offers out loud', () => {
  it('shows every sound level, because it is the surface that plays them', async () => {
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.settings'))
    await act(async () => {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.focus.sound')}"]`)!.click()
      await Promise.resolve()
    })

    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].map((row) => row.textContent ?? '')
    for (const level of ['sound_off', 'sound_tick', 'sound_chime', 'sound_both'] as const) {
      expect(labels.some((label) => label.includes(t(`todo.focus.${level}`))), level).toBe(true)
    }
  })

  it('writes the level the reader picks through the settings door', async () => {
    const updateSettings = vi.fn()
    useSession.setState({ updateSettings })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.settings'))
    await act(async () => {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.focus.sound')}"]`)!.click()
      await Promise.resolve()
    })
    const row = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
      .find((node) => (node.textContent ?? '').includes(t('todo.focus.sound_both')))
    await act(async () => {
      row!.click()
      await Promise.resolve()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, sound: 'both' } },
    })
  })
})

describe('a page with no Web Audio', () => {
  it('still runs a session from start to end', async () => {
    // jsdom has no AudioContext at all, which is exactly the platform this case is about: a cue the
    // browser cannot make may not be the reason a block fails to finish.
    expect(window.AudioContext).toBeUndefined()
    focusSettings({ strategy: 'countdown', defaultMinutes: 1, sound: 'both' })
    mount()
    openFocus()
    await flush()
    await press(t('todo.focus.start'))
    advance(60_000)

    expect(screenName()).toBe('session-done')
    expect(starts()).toBe(1)
    expect(stops()).toBe(1)
  })
})
