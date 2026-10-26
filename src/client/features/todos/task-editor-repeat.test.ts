// @vitest-environment jsdom
/**
 * The repeat controls in the editor: a weekly rule can name days, a monthly one can land on the last.
 *
 * What the panel saves is what the server stores, so these cases press the controls and read the body
 * the store's create action received — a selector that renders but never reaches the rule would still
 * look right on screen.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { chooseOption, selectedLabel } from '../../lib/test-menu'

// The export helpers inline KaTeX's stylesheet, which Vite refuses through this checkout's symlinked
// `node_modules`; nothing here exports a note or renders math.
vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

import type { MessageKey } from '@shared/locales/en-US'
import type { RepeatRule, TodoTask } from '@shared/todos/model'
import { useTodos, type TaskDraft } from './store'
import { TaskEditor } from './TaskEditor'

const original = useTodos.getState()
const created = vi.fn<(input: TaskDraft) => Promise<TodoTask | null>>().mockResolvedValue(null)
const updated = vi.fn<(id: string, patch: Record<string, unknown>) => Promise<TodoTask | null>>().mockResolvedValue(null)
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  created.mockClear()
  updated.mockClear()
  useTodos.setState(original, true)
  useTodos.setState({
    editorOpen: true,
    draft: { title: 'Standup' },
    lists: [],
    tags: [],
    tasks: [],
    completed: [],
    timezone: 'UTC',
    saving: false,
    createTask: created,
    updateTask: updated,
  })
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

/** The editor's own container, which is where a select-menu's trigger lives. */
function panel(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the editor did not open')
  return dialog
}

function weekdayGroup(): HTMLElement {
  const group = document.querySelector<HTMLElement>(`[role="group"][aria-label="${t('todo.repeat.weekdays')}"]`)
  if (!group) throw new Error('a weekly rule offers no weekday buttons')
  return group
}

function weekdayButton(label: string): HTMLButtonElement {
  const button = [...weekdayGroup().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.getAttribute('aria-label') === label)
  if (!button) throw new Error(`the weekday row has no ${label} button`)
  return button
}

async function save(): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the editor offers no save button')
  act(() => { button.click() })
  await act(async () => { await Promise.resolve() })
}

function savedRepeat(): unknown {
  expect(created).toHaveBeenCalledTimes(1)
  return created.mock.calls[0]![0].repeat
}

describe('the repeat controls', () => {
  it('saves the weekdays a weekly rule names', async () => {
    view = renderElement(createElement(TaskEditor))
    await chooseOption(panel(), t('todo.task.repeat_label'), t('todo.repeat.weekly'))

    for (const label of ['assistant.weekday.1', 'assistant.weekday.3', 'assistant.weekday.5'] as MessageKey[]) {
      act(() => { weekdayButton(t(label)).click() })
    }
    // The pressed state is the state a screen reader hears, not only a colour.
    expect(weekdayButton(t('assistant.weekday.3')).getAttribute('aria-pressed')).toBe('true')

    await save()
    expect(savedRepeat()).toEqual({ freq: 'weekly', interval: 1, weekdays: [1, 3, 5] })
  })

  it('saves a monthly rule that lands on the last day', async () => {
    view = renderElement(createElement(TaskEditor))
    await chooseOption(panel(), t('todo.task.repeat_label'), t('todo.repeat.monthly'))
    await chooseOption(panel(), t('todo.repeat.monthly_mode'), t('todo.repeat.last_day'))

    await save()
    expect(savedRepeat()).toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'lastDay' })
  })
})

/** One stored task, so the panel opens on a rule it can only read. */
function stored(id: string, dueAt: number | null, repeat: RepeatRule | null): TodoTask {
  return {
    id,
    title: 'Rent',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

/** The 2026-10-16 09:00 the account zone reads as UTC: the third Friday of that month. */
const THIRD_FRIDAY = Date.UTC(2026, 9, 16, 9, 0)

describe('a monthly rule on an nth weekday', () => {
  /** Opens the panel on the stored task and lets its row land. */
  async function editRepeating(task: TodoTask): Promise<void> {
    useTodos.setState({ draft: { id: task.id }, tasks: [task] })
    view = renderElement(createElement(TaskEditor))
    await act(async () => { await Promise.resolve() })
  }

  it('reads the mode back rather than folding it into the due date', async () => {
    await editRepeating(stored('r1', THIRD_FRIDAY, { freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' }))

    expect(
      selectedLabel(panel(), t('todo.repeat.monthly_mode')),
      'an nth-weekday rule reads as "on the due date" the moment the panel opens',
    ).toBe(t('todo.repeat.nth_weekday'))
  })

  it('saves the nth-weekday rule it was opened with, untouched', async () => {
    await editRepeating(stored('r1', THIRD_FRIDAY, { freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' }))

    await save()
    expect(updated).toHaveBeenCalledTimes(1)
    expect(updated.mock.calls[0]![1].repeat)
      .toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' })
  })

  it('shows which nth weekday the due date the rule reads already sits on', async () => {
    await editRepeating(stored('r1', THIRD_FRIDAY, { freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' }))

    expect(selectedLabel(panel(), t('todo.repeat.nth'))).toBe(t('todo.repeat.nth_3'))
    expect(weekdayButton(t('assistant.weekday.5')).getAttribute('aria-pressed')).toBe('true')
  })

  it('moves the due date to the weekday the reader picks, and keeps its time', async () => {
    await editRepeating(stored('r1', THIRD_FRIDAY, { freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' }))

    await chooseOption(panel(), t('todo.repeat.nth'), t('todo.repeat.nth_1'))
    act(() => { weekdayButton(t('assistant.weekday.1')).click() })
    await save()

    // October 2026: its first Monday is the 5th, and the 09:00 the task was owed at stays on it.
    expect(updated.mock.calls[0]![1].dueAt).toBe('2026-10-05T09:00')
    expect(updated.mock.calls[0]![1].repeat)
      .toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' })
  })

  it('creates the mode from a task that never had one', async () => {
    useTodos.setState({ draft: { title: 'Rent', dueAt: '2026-10-16T09:00' } })
    view = renderElement(createElement(TaskEditor))
    await act(async () => { await Promise.resolve() })

    await chooseOption(panel(), t('todo.task.repeat_label'), t('todo.repeat.monthly'))
    await chooseOption(panel(), t('todo.repeat.monthly_mode'), t('todo.repeat.nth_weekday'))
    await save()

    expect(created.mock.calls[0]![0].repeat)
      .toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' })
  })
})
