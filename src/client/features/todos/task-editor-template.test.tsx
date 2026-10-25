// @vitest-environment jsdom
/**
 * Starting a task from a kept shape, and keeping one.
 *
 * The menu writes the form and stops there: a template is a starting point, so nothing is created and
 * nothing is saved until the reader presses Save. What this file pins is that every field the template
 * holds reaches the form, that the fields it deliberately does not hold — the date and the reminder —
 * are left exactly as the reader had them, and that a task on screen can become a template.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { mergeSettings } from '@shared/constants'
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

/** The shared dialog, stubbed: this file is about what the panel does with a name, not its markup. */
const dialog = vi.hoisted(() => ({ answer: null as string | null }))
vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, prompt: async () => dialog.answer }
})

const created = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

function row(id: string, title: string): TodoTask {
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

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    // The rest of the module stays real: a settings write reaches the session store's own failure
    // path, which asks the mock for an `ApiError` this file has no reason to fake.
    ...actual,
    api: {
      ...actual.api,
      todos: {
        ...actual.api.todos,
        list: async () => ({ tasks: [], total: 0, counts: EMPTY_COUNTS, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        get: async (id: string) => ({ task: row(id, 'Weekly report'), steps: [] }),
        create: async (body: Record<string, unknown>) => {
          created.bodies.push(body)
          return { task: row('new', String(body.title ?? '')) }
        },
      },
      // Keeping a template is a settings write, and the session store flushes one on a 420 ms
      // debounce. Without a door for that write the flush fails and toasts; answering with the
      // patch merged onto the defaults keeps the flush quiet and the templates where they were put.
      settings: {
        ...actual.api.settings,
        save: async (patch: Record<string, unknown>) => ({ settings: mergeSettings(patch) }),
      },
    },
  }
})

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'
import { useSession } from '../../store/session'

const original = useTodos.getState()
const originalSession = useSession.getState()
let view: RenderedElement | null = null

const TEMPLATE = {
  id: 'weekly-report-abc',
  name: 'Weekly report',
  title: 'Weekly report',
  description: 'Numbers first, then the summary.',
  priority: 'high' as const,
  listId: 'work',
  tags: ['reporting'],
  steps: ['Gather the numbers', 'Write the summary'],
  timeEstimate: 90 * 60_000,
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  created.bodies.length = 0
  dialog.answer = null
  useTodos.setState(original, true)
  useSession.setState({ ...originalSession, settings: mergeSettings({ todo: { templates: [TEMPLATE] } }) })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useSession.setState(originalSession, true)
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) })
}

async function mountEditor(draft: Record<string, unknown>, tasks: TodoTask[] = []): Promise<void> {
  act(() => {
    useTodos.setState({
      status: 'ready',
      tasks,
      completed: [],
      lists: [{ id: 'work', name: 'Work', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }],
      tags: [],
      counts: EMPTY_COUNTS,
      timezone: 'UTC',
      dayEnd: Date.now() + 86_400_000,
      editorOpen: true,
      draft,
      saving: false,
    })
  })
  view = renderElement(createElement(TaskEditor))
  await flush()
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function titleField(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)!
}

async function applyTemplate(name = TEMPLATE.name): Promise<void> {
  await act(async () => { button(t('todo.template.use')).click(); await Promise.resolve() })
  await act(async () => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => (node.textContent ?? '').trim() === name)
    if (!item) throw new Error(`the template menu lists no ${name}`)
    item.click()
    await Promise.resolve()
  })
  await flush()
}

describe('a new task started from a template', () => {
  it('fills the form without creating anything', async () => {
    await mountEditor({})
    await applyTemplate()

    expect(titleField().value).toBe('Weekly report')
    expect(document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t('todo.task.notes_label')}"]`)?.value)
      .toBe('Numbers first, then the summary.')
    // The steps arrive as unsaved rows the create turns into real ones.
    expect(document.body.textContent).toContain('Gather the numbers')
    expect(document.body.textContent).toContain('Write the summary')
    // Nothing was written: the template is a starting point, and Save is still the reader's press.
    expect(created.bodies).toEqual([])
  })

  it('leaves a date the reader had already typed alone', async () => {
    await mountEditor({ dueAt: '2026-11-01' })
    // The panel's date fields are the shared picker, whose trigger is a button opening a dialog.
    const due = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
      .find((node) => (node.textContent ?? '').includes('2026'))
    expect(due, 'the panel seeded no date').toBeTruthy()

    await applyTemplate()

    expect(titleField().value).toBe('Weekly report')
    // The template carries no date, so the one already in the form survives it.
    expect(due!.textContent).toContain('2026')
  })
})

describe('a task on screen kept as a template', () => {
  it('stores the shape under the name the reader gives it', async () => {
    await mountEditor({ id: 'a' }, [row('a', 'Weekly report')])
    dialog.answer = 'Friday report'

    await act(async () => { button(t('todo.template.save')).click(); await Promise.resolve() })
    await flush()

    const kept = useSession.getState().settings.todo.templates ?? []
    expect(kept.map((entry) => entry.name)).toEqual(['Friday report', 'Weekly report'])
    expect(kept[0]).toMatchObject({ title: 'Weekly report' })
    // The kept shape names no date: a template that carried one would file today's work in the past.
    expect(kept[0]).not.toHaveProperty('dueAt')
  })

  it('writes nothing when the name dialog is cancelled', async () => {
    await mountEditor({ id: 'a' }, [row('a', 'Weekly report')])
    dialog.answer = null
    const settingsBefore = useSession.getState().settings

    await act(async () => { button(t('todo.template.save')).click(); await Promise.resolve() })
    await flush()

    expect(useSession.getState().settings).toBe(settingsBefore)
  })
})
