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
import { chooseOption } from '../../lib/test-menu'

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
import type { TodoTask } from '@shared/todos/model'
import { useTodos, type TaskDraft } from './store'
import { TaskEditor } from './TaskEditor'

const original = useTodos.getState()
const created = vi.fn<(input: TaskDraft) => Promise<TodoTask | null>>().mockResolvedValue(null)
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  created.mockClear()
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
