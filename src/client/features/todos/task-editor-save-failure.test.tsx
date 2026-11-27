// @vitest-environment jsdom
/**
 * A save that did not land leaves the panel — and the draft — where they were.
 *
 * `updateTask` and `createTask` answer `null` when the write was refused, and the panel used to close
 * on that answer anyway: the toast named the failure while the fields that carried the reader's work
 * went off screen with it. The other half is the press that arrives twice: Enter is a save in this
 * panel, and two of them while the first request is still out created the task twice.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

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

const server = vi.hoisted(() => ({
  rows: new Map<string, TodoTask>(),
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  created: [] as Record<string, unknown>[],
  failUpdate: false,
  holdCreate: false,
  releaseCreate: null as null | (() => void),
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
      update: async (id: string, patch: Record<string, unknown>) => {
        server.updates.push({ id, patch })
        if (server.failUpdate) throw new Error('The server refused the write.')
        const next = { ...server.rows.get(id)!, ...patch } as TodoTask
        server.rows.set(id, next)
        return { task: next, next: null }
      },
      create: async (body: Record<string, unknown>) => {
        server.created.push(body)
        if (server.holdCreate) {
          await new Promise<void>((resolve) => { server.releaseCreate = resolve })
        }
        const created = task('made', String(body.title ?? ''))
        server.rows.set('made', created)
        return { task: created }
      },
    },
  },
}))

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

function task(id: string, title: string): TodoTask {
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
    parentId: null,
    dependsOn: [],
    blocks: [],
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.rows.clear()
  server.updates.length = 0
  server.created.length = 0
  server.failUpdate = false
  server.holdCreate = false
  server.releaseCreate = null
  server.rows.set('a', task('a', 'File the return'))
  useTodos.setState(original, true)
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function open(state: { draft: Record<string, unknown>; tasks: TodoTask[] }): void {
  act(() => {
    useTodos.setState({
      status: 'ready',
      tasks: state.tasks,
      completed: [],
      lists: [],
      tags: [],
      counts: { ...EMPTY_COUNTS, all: state.tasks.length },
      timezone: 'UTC',
      dayEnd: Date.now() + 86_400_000,
      editorOpen: true,
      draft: state.draft,
      saving: false,
    })
  })
}

async function mountEditor(row: TodoTask): Promise<void> {
  open({ draft: { id: row.id }, tasks: [row] })
  view = renderElement(createElement(TaskEditor))
  await flush()
}

async function mountDraft(draft: Record<string, unknown>): Promise<void> {
  open({ draft, tasks: [] })
  view = renderElement(createElement(TaskEditor))
  await flush()
}

function panel(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the editor did not open')
  return dialog
}

function titleField(): HTMLInputElement {
  const field = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
  if (!field) throw new Error('the editor offers no title field')
  return field
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function saveButton(): HTMLButtonElement {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the editor offers no save button')
  return button
}

describe('a save the server refused', () => {
  it('keeps the panel open on the draft the reader typed', async () => {
    server.failUpdate = true
    await mountEditor(server.rows.get('a')!)
    typeInto(titleField(), 'File the return early')

    act(() => { saveButton().click() })
    await flush()

    expect(server.updates).toHaveLength(1)
    expect(server.updates[0]!.patch.title).toBe('File the return early')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(useTodos.getState().editorOpen).toBe(true)
    expect(titleField().value).toBe('File the return early')
  })

  it('creates once when Enter is pressed twice before the first answer', async () => {
    server.holdCreate = true
    await mountDraft({ title: 'Buy stamps' })

    const field = titleField()
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()

    expect(server.created).toHaveLength(1)

    await act(async () => {
      server.releaseCreate?.()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })

    expect(useTodos.getState().editorOpen).toBe(false)
  })
})
