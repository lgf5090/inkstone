// @vitest-environment jsdom
/**
 * The panel is seeded when it opens, and never again while the reader is typing.
 *
 * A step write and the assistant's own refresh both replace the `tasks` array. An effect that watched
 * that array re-read the server row on every one of them, so adding a step under a half-typed title
 * put the stored title back — the reader's words gone, with nothing on screen to say why. These cases
 * hold the two events that used to trigger it, and the one event that must still reseed: being handed
 * another task.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskStep, TodoTask } from '@shared/todos/model'

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
  steps: new Map<string, TaskStep[]>(),
  added: [] as { taskId: string; text: string }[],
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
      get: async (id: string) => ({ task: server.rows.get(id)!, steps: server.steps.get(id) ?? [] }),
      addStep: async (taskId: string, text: string) => {
        server.added.push({ taskId, text })
        const step: TaskStep = {
          id: `step-${server.added.length}`,
          taskId,
          text,
          done: false,
          position: (server.steps.get(taskId) ?? []).length,
          createdAt: 1,
        }
        server.steps.set(taskId, [...(server.steps.get(taskId) ?? []), step])
        return { step }
      },
    },
  },
}))

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

function task(id: string, title: string, description = ''): TodoTask {
  return {
    id,
    title,
    description,
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
  server.steps.clear()
  server.added.length = 0
  server.rows.set('a', task('a', 'File the return'))
  server.rows.set('b', task('b', 'Pay the invoice', 'The one from March'))
  useTodos.setState(original, true)
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

/** Let the panel's own reads and the store's writes run to completion. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

async function mountEditor(row: TodoTask): Promise<void> {
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

function titleField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
  if (!field) throw new Error('the editor offers no title field')
  return field
}

function notesField(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('todo.task.notes_label')}"]`)
  if (!field) throw new Error('the editor offers no notes field')
  return field
}

function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('seeding the task editor', () => {
  it('keeps a typed title when a step write replaces the row', async () => {
    await mountEditor(server.rows.get('a')!)
    typeInto(titleField(), 'File the return early')

    await act(async () => { await useTodos.getState().addStep('a', 'Call the accountant') })
    await flush()

    // The step write reached the server and replaced the row it belongs to; the title in the box is
    // still the reader's, not the stored one the reload brought back.
    expect(server.added).toEqual([{ taskId: 'a', text: 'Call the accountant' }])
    expect(titleField().value).toBe('File the return early')
  })

  it('keeps typed notes when an outside load replaces the tasks array', async () => {
    await mountEditor(server.rows.get('a')!)
    typeInto(notesField(), 'Two copies, one for the file')

    act(() => {
      useTodos.setState({ tasks: [{ ...server.rows.get('a')!, title: 'Changed elsewhere' }] })
    })

    expect(notesField().value).toBe('Two copies, one for the file')
  })

  it('reseeds every field when the panel is handed another task', async () => {
    await mountEditor(server.rows.get('a')!)
    expect(titleField().value).toBe('File the return')

    act(() => {
      useTodos.setState({ tasks: [server.rows.get('a')!, server.rows.get('b')!], draft: { id: 'b' } })
    })
    await flush()

    expect(titleField().value).toBe('Pay the invoice')
    expect(notesField().value).toBe('The one from March')
  })
})
