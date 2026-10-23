// @vitest-environment jsdom
/**
 * The ledger on the row: what was planned, what it took, and the way to change the plan.
 *
 * R1-2 puts the estimate and the spent total where a reader decides to start work, and three things
 * have to be true for that to be an interface rather than a decoration.
 *
 * The numbers have to *read* as durations — `1h 30m / 2h` — because a row that prints `5400000` asks
 * the reader to do arithmetic on a millisecond count, and the same words are what the estimate field
 * accepts back.
 *
 * The chip has to be a control that survives inside a row that is itself one press. The body of a card
 * is covered by an absolutely positioned button, so a later sibling that is not lifted above it takes
 * the row's press instead of its own. Both halves are asserted: the dialog opens, and "open the task"
 * does not. That is the inline-control-falls-under-the-hit-line defect class, invisible unless asked.
 *
 * And the press has to land: choosing a preset writes the estimate through the same guarded update
 * every other card write uses, and the row the reader is looking at carries the new number afterwards.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const server = vi.hoisted(() => ({
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}))

vi.mock('../../lib/api', () => {
  const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
  const base = (id: string): TodoTask => ({
    id,
    title: 'Write the report',
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
  })
  return {
    api: {
      todos: {
        update: async (id: string, patch: Record<string, unknown>) => {
          server.updates.push({ id, patch })
          // The route answers with the row as it now reads, estimate column included — which is what
          // lets the assertion below be about the row rather than about the request.
          const answer: Partial<TodoTask> = { ...patch } as Partial<TodoTask>
          if ('timeEstimate' in patch) {
            delete (answer as Record<string, unknown>).timeEstimate
            answer.timeEstimateMs = patch.timeEstimate as number | null
          }
          return { task: { ...base(id), ...answer }, next: null }
        },
        list: async () => ({ tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      },
    },
  }
})

import { TaskCard } from './TaskCard'
import { useTodos } from './store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-10-20T09:00:00Z')

function row(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: 'Write the report',
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

const original = useTodos.getState()
let view: RenderedElement | null = null
let opened = 0

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.updates.length = 0
  opened = 0
  useTodos.setState(original, true)
  useTodos.setState({ lists: [], timezone: 'UTC', dayEnd: NOW + 86_400_000, selectedIds: new Set<string>() })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

function mount(task: TodoTask): void {
  useTodos.setState({ tasks: [task], completed: [], total: 1 })
  view = renderElement(createElement(TaskCard, {
    task,
    lists: [],
    bounds: { dayEnd: NOW + 86_400_000, now: NOW },
    timezone: 'UTC',
    onOpen: () => { opened += 1 },
    onStar: () => {},
  }))
}

function chip(): HTMLButtonElement {
  const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-estimate]')
  if (!button) throw new Error('the row shows no estimate control')
  return button
}

/** Press the chip the way a pointer does: a real click on the control itself. */
function pressChip(): void {
  act(() => { chip().click() })
}

function dialog(): HTMLElement {
  const surface = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!surface) throw new Error('pressing the estimate opened no dialog')
  return surface
}

function presetTrigger(): HTMLButtonElement {
  const trigger = dialog().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
  if (!trigger) throw new Error('the estimate field has no menu trigger')
  return trigger
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!item) throw new Error(`no menu row named ${label}`)
  return item
}

async function save(): Promise<void> {
  const button = dialog().querySelector<HTMLButtonElement>('[data-estimate-save]')
  if (!button) throw new Error('the estimate dialog offers no save')
  await act(async () => {
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function choosePreset(label: string): Promise<void> {
  act(() => { presetTrigger().click() })
  await act(async () => {
    menuItem(label).click()
    await Promise.resolve()
  })
}

function customField(): HTMLInputElement {
  const field = dialog().querySelector<HTMLInputElement>('[data-estimate-custom]')
  if (!field) throw new Error('the estimate dialog has no custom field')
  return field
}

function typeCustom(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(customField(), value)
    customField().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the durations a row carries', () => {
  it('prints spent over estimate in the duration grammar', () => {
    mount(row('a', { timeSpentMs: 90 * MINUTE, timeEstimateMs: 2 * HOUR }))
    expect(chip().textContent).toBe('1h 30m / 2h')
  })

  it('prints the zero it means when nothing has been logged yet', () => {
    mount(row('a', { timeSpentMs: 0, timeEstimateMs: HOUR }))
    expect(chip().textContent).toBe('0m / 1h')
  })

  it('prints the spent total alone when nobody planned a duration', () => {
    mount(row('a', { timeSpentMs: 45 * MINUTE, timeEstimateMs: null }))
    expect(chip().textContent).toBe('45m')
  })

  it('still offers the door on a row with neither number', () => {
    // Chosen over hiding the chip when there is nothing to report: a task that has never had an
    // estimate and never been timed would otherwise have no way to acquire one from the listing,
    // because the editor does not carry the field yet. The control shows the hourglass alone.
    mount(row('a', { timeSpentMs: 0, timeEstimateMs: null }))
    expect(view!.container.querySelector('[data-todo-estimate]')).not.toBeNull()
  })

  it('takes the press for itself instead of opening the task behind it', () => {
    mount(row('a', { timeSpentMs: 90 * MINUTE, timeEstimateMs: 2 * HOUR }))
    pressChip()
    expect(opened).toBe(0)
    expect(document.querySelector('[role="dialog"]'),
      'the estimate press went through to the row body').not.toBeNull()
  })
})

describe('the estimate dialog', () => {
  it('is a menu and a text field, never a native select or a number spinner', () => {
    mount(row('a', { timeEstimateMs: 2 * HOUR }))
    pressChip()
    expect(presetTrigger()).toBeTruthy()
    expect(dialog().querySelector('select')).toBeNull()
    expect(dialog().querySelector('input[type="number"]')).toBeNull()
  })

  it('writes the chosen estimate through the row guard and repaints the row', async () => {
    mount(row('a', { timeEstimateMs: 2 * HOUR, rev: 4 }))
    pressChip()
    await choosePreset('3h')
    await save()
    expect(server.updates).toEqual([{ id: 'a', patch: { timeEstimate: 3 * HOUR } }])
    expect(useTodos.getState().tasks.find((entry) => entry.id === 'a')!.timeEstimateMs).toBe(3 * HOUR)
  })

  it('reads a typed duration back as milliseconds', async () => {
    mount(row('a', { timeEstimateMs: null }))
    pressChip()
    typeCustom('1h20m')
    await save()
    expect(server.updates).toEqual([{ id: 'a', patch: { timeEstimate: 80 * MINUTE } }])
  })

  it('refuses words that are not a duration instead of writing zero', async () => {
    mount(row('a', { timeEstimateMs: 2 * HOUR }))
    pressChip()
    typeCustom('soon')
    await save()
    expect(server.updates).toEqual([])
    expect(useTodos.getState().tasks.find((entry) => entry.id === 'a')!.timeEstimateMs).toBe(2 * HOUR)
  })

  it('takes the estimate back out when the reader picks none', async () => {
    mount(row('a', { timeEstimateMs: 2 * HOUR }))
    pressChip()
    await choosePreset(t('todo.time.none'))
    await save()
    expect(server.updates).toEqual([{ id: 'a', patch: { timeEstimate: null } }])
  })
})

describe('the consumption bar', () => {
  it('runs under a row that is being timed, and says how far it has gone', () => {
    mount(row('a', { timeEstimateMs: 2 * HOUR, timeSpentMs: HOUR, runningSince: NOW - 30 * MINUTE }))
    const bar = view!.container.querySelector<HTMLElement>('[data-todo-estimate-bar]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('aria-hidden')).toBe('true')
    // An hour closed plus the half hour still running, against a two hour plan.
    expect(bar!.style.getPropertyValue('--todo-estimate-progress')).toBe('75')
  })

  it('never promises past the plan it was measured against', () => {
    mount(row('a', { timeEstimateMs: HOUR, timeSpentMs: 3 * HOUR, runningSince: NOW - MINUTE }))
    const bar = view!.container.querySelector<HTMLElement>('[data-todo-estimate-bar]')
    expect(bar!.style.getPropertyValue('--todo-estimate-progress')).toBe('100')
  })

  it('stays off a row that is not being timed, even one past its plan', () => {
    mount(row('a', { timeEstimateMs: HOUR, timeSpentMs: 2 * HOUR, runningSince: null }))
    expect(view!.container.querySelector('[data-todo-estimate-bar]')).toBeNull()
  })

  it('stays off a running row that has no plan to consume', () => {
    mount(row('a', { timeEstimateMs: null, timeSpentMs: HOUR, runningSince: NOW - MINUTE }))
    expect(view!.container.querySelector('[data-todo-estimate-bar]')).toBeNull()
  })
})
