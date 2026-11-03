// @vitest-environment jsdom
/**
 * The task editor's form belongs to the reader until they save it.
 *
 * Two writes happen beside the form's own fields: adding or ticking a step refreshes the row list, and
 * saving can be refused. The first must not re-seed the panel (a step press used to wipe a half-typed
 * title), and the second must not close it (a failed save used to look like a successful one).
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

const server = vi.hoisted(() => ({
  rows: new Map<string, TodoTask>(),
  failUpdate: false,
}))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: [...server.rows.values()],
        total: server.rows.size,
        counts: { ...EMPTY_COUNTS, all: server.rows.size },
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => ({ task: server.rows.get(id)!, steps: [] }),
      update: async () => {
        if (server.failUpdate) throw new Error('the row could not be saved')
        return { task: [...server.rows.values()][0]!, next: null }
      },
      create: async (body: Record<string, unknown>) => ({ task: { ...task('made'), ...body } }),
    },
  },
}))

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
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
    ...extra,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.rows.clear()
  server.failUpdate = false
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

async function mountEditor(row: TodoTask): Promise<void> {
  server.rows.set(row.id, row)
  act(() => {
    useTodos.setState({
      status: 'ready',
      tasks: [row],
      completed: [],
      lists: [],
      tags: [],
      counts: { ...EMPTY_COUNTS, all: 1 },
      timezone: 'UTC',
      dayEnd: Date.now() + 86_400_000,
      editorOpen: true,
      draft: { id: row.id },
      saving: false,
    })
  })
  view = renderElement(createElement(TaskEditor))
  await flush()
}

function panel(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the editor did not open')
  return dialog
}

function titleField(): HTMLInputElement {
  const input = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
  if (!input) throw new Error('the editor shows no title field')
  return input
}

function notesField(): HTMLTextAreaElement {
  const area = panel().querySelector<HTMLTextAreaElement>('textarea')
  if (!area) throw new Error('the editor shows no notes field')
  return area
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressSave(): Promise<void> {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the editor offers no save button')
  await act(async () => {
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

describe('the task editor form', () => {
  it('keeps unsaved fields when a step write refreshes the row list', async () => {
    await mountEditor(task('a'))
    typeInto(titleField(), 'Half-typed title')
    typeInto(notesField(), 'Half-typed notes')

    // What addStep()/updateStep() does: the store answers with a fresh row array.
    act(() => {
      useTodos.setState({ tasks: [{ ...server.rows.get('a')!, stepTotal: 1, stepDone: 1 }] })
    })
    await flush()

    expect(titleField().value).toBe('Half-typed title')
    expect(notesField().value).toBe('Half-typed notes')
  })

  it('stays open when the save is refused', async () => {
    await mountEditor(task('a'))
    server.failUpdate = true

    await pressSave()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(titleField().value).toBe('Write the report')
  })
})
