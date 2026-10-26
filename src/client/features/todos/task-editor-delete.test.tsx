// @vitest-environment jsdom
/**
 * One press deletes a task, and the toast that follows is the way back.
 *
 * C3 is not a new feature: the store already restores the stamped row rather than re-creating one
 * (`store-undo.test.ts` pins that), and a row that misses the toast waits in the trash. So the editor
 * was asking a question twice — a dialog, then a write the reader could already take back. The case
 * below is the whole of the change read at the API boundary: one press on the delete row leaves no
 * dialog on the screen, sends exactly one delete, and puts a working undo on the rail.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import type { TodoTask } from '@shared/todos/model'

// The export helpers inline KaTeX's stylesheet, which Vite refuses through this checkout's symlinked
// `node_modules`; nothing here exports a note.
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
  removes: [] as string[],
  restores: [] as string[],
  rows: new Map<string, TodoTask>(),
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
      remove: async (id: string) => {
        server.removes.push(id)
        return { deleted: true as const }
      },
      restore: async (id: string) => {
        server.restores.push(id)
        return { task: server.rows.get(id)!, droppedReminders: 0 }
      },
    },
  },
}))

import { Toaster } from '../../components/feedback'
import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

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
  }
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.removes.length = 0
  server.restores.length = 0
  server.rows.clear()
  server.rows.set('t1', task('t1', 'File the return'))
  useUi.setState({ toasts: [] })
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    editorOpen: true,
    draft: { id: 't1' },
    tasks: [server.rows.get('t1')!],
    completed: [],
    total: 1,
    lists: [],
    tags: [],
    timezone: 'UTC',
    saving: false,
  })
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

/** Let the delete, the toast and the reload run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function deleteButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.delete'))
  if (!button) throw new Error('the editor offers no delete button')
  return button
}

function undoButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.undo'))
  if (!button) throw new Error('the toast offered no undo')
  return button
}

describe('deleting a task from the editor', () => {
  it('deletes on the press, asks nothing, and leaves an undo behind', async () => {
    view = renderElement(createElement('div', {}, [
      createElement(TaskEditor, { key: 'editor' }),
      createElement(Toaster, { key: 'toaster' }),
    ]))
    expect(document.querySelectorAll('[role="dialog"]').length, 'the editor is not open').toBe(1)

    act(() => { deleteButton().click() })
    await settle()

    // One press, one delete, and no second dialog left standing where the question used to be asked.
    expect(server.removes).toEqual(['t1'])
    expect(document.querySelectorAll('[role="dialog"]'), 'a dialog is still on screen').toHaveLength(0)
    expect(useTodos.getState().editorOpen).toBe(false)

    act(() => { undoButton().click() })
    await settle()

    // The way back is the row the delete stamped, not a copy of it.
    expect(server.restores).toEqual(['t1'])
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['t1'])
  })
})
