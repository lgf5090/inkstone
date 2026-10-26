// @vitest-environment jsdom
/**
 * The estimate field in the task editor: the plan a reader types reaches the row through the save.
 *
 * R1-2 put the estimate on the row and on the card's chip, and the chip deliberately stays visible even
 * where there is nothing to report — a task nobody has planned yet has to be able to acquire its first
 * estimate from somewhere. This panel is that somewhere for every path a task takes that is not the
 * chip, so these cases drive it the way a reader does: open it on a row, pick or type a duration, press
 * Save, and read the number back off the row *in the store* rather than off the request. A field that
 * only proved the request was shaped right would still pass while the screen kept showing the old plan.
 *
 * Two properties are load-bearing. The field reuses the picker's own ladder and the shared duration
 * grammar, so `1h20m` means here exactly what it means on the chip and in the quick-add line — a second
 * parser would eventually disagree about `90`. And the estimate rides the one PATCH every other field of
 * this panel already shares: two orders of arrival for one save is one save that can half-land.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { chooseOption, selectedLabel } from '../../lib/test-menu'
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
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  created: [] as Record<string, unknown>[],
  rows: new Map<string, TodoTask>(),
}))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

/**
 * The route, as far as this panel is concerned: it takes `timeEstimate` and answers with the row whose
 * `timeEstimateMs` column has moved. Naming the reply after the column rather than the request is what
 * makes the assertions below about the row the reader is looking at.
 */
function answerWith(row: TodoTask, patch: Record<string, unknown>): TodoTask {
  const body: Record<string, unknown> = { ...patch }
  if ('timeEstimate' in body) {
    body.timeEstimateMs = body.timeEstimate
    delete body.timeEstimate
  }
  return { ...row, ...body } as TodoTask
}

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
        const next = answerWith(server.rows.get(id)!, patch)
        server.rows.set(id, next)
        return { task: next, next: null }
      },
      create: async (body: Record<string, unknown>) => {
        server.created.push(body)
        const created = answerWith(task('made', { title: '' }), body)
        server.rows.set('made', created)
        return { task: created }
      },
    },
  },
}))

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

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
  server.updates.length = 0
  server.created.length = 0
  server.rows.clear()
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  // The panel and its menus are portals on the body; a leftover dialog would be the next case's panel.
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

/** Let the panel's own first reads (its steps) land before a case starts pressing controls. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** Open the panel on a stored row, which is the case every assertion below is about. */
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

/** Open the panel on a draft, which is what quick add and the calendar's box-select hand it. */
async function mountDraft(draft: Record<string, unknown>): Promise<void> {
  act(() => {
    useTodos.setState({
      status: 'ready',
      tasks: [],
      completed: [],
      lists: [],
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

function panel(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the editor did not open')
  return dialog
}

/**
 * The block the estimate label names.
 *
 * The field is two controls, so `Field` hands its words to the group rather than to one of them — and
 * that group is what a reader (and the native-control assertions) has to be pointed at, not the panel.
 */
function estimateGroup(): HTMLElement {
  const label = [...panel().querySelectorAll<HTMLLabelElement>('label')]
    .find((node) => (node.textContent ?? '').trim() === t('todo.time.label'))
  if (!label) throw new Error('the editor shows no estimate label')
  const group = panel().querySelector<HTMLElement>(`[role="group"][aria-labelledby="${label.id}"]`)
  if (!group) throw new Error('the estimate label names no control group')
  return group
}

function customField(): HTMLInputElement {
  const field = estimateGroup().querySelector<HTMLInputElement>('[data-estimate-custom]')
  if (!field) throw new Error('the estimate field has no custom entry')
  return field
}

function typeCustom(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(customField(), value)
    customField().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Press the panel's own Save and let the store's write land. */
async function pressSave(): Promise<void> {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the editor offers no save button')
  await act(async () => {
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** The row as the store now holds it — the answer the reader sees, not the one that was asked for. */
function storedRow(id = 'a'): TodoTask {
  return useTodos.getState().tasks.find((entry) => entry.id === id)!
}

describe('the estimate field', () => {
  it('opens on the estimate the row already carries', async () => {
    await mountEditor(task('a', { timeEstimateMs: 2 * HOUR }))

    expect(selectedLabel(panel(), t('todo.time.label'))).toBe('2h')
  })

  it('writes a preset picked here through the save, and the row in the store carries it', async () => {
    await mountEditor(task('a', { timeEstimateMs: 2 * HOUR }))

    await chooseOption(panel(), t('todo.time.label'), '3h')
    await pressSave()

    expect(server.updates).toHaveLength(1)
    expect(server.updates[0]!.id).toBe('a')
    expect(server.updates[0]!.patch.timeEstimate).toBe(3 * HOUR)
    expect(storedRow().timeEstimateMs).toBe(3 * HOUR)
  })

  it('parses a typed duration with the same grammar the row and the chip speak', async () => {
    await mountEditor(task('a', { timeEstimateMs: null }))

    typeCustom('1h20m')
    await pressSave()

    expect(server.updates).toHaveLength(1)
    expect(server.updates[0]!.patch.timeEstimate).toBe(80 * MINUTE)
    expect(storedRow().timeEstimateMs).toBe(80 * MINUTE)
  })

  it('rides the one PATCH the panel already sends, beside the title it also writes', async () => {
    await mountEditor(task('a', { timeEstimateMs: null }))

    const title = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
    expect(title).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(title!, 'Write the long report')
      title!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    typeCustom('45m')
    await pressSave()

    // One request for one save: a second write path for the estimate would be a save that can half-land.
    expect(server.updates).toHaveLength(1)
    expect(server.updates[0]!.patch).toMatchObject({ title: 'Write the long report', timeEstimate: 45 * MINUTE })
    expect(storedRow().title).toBe('Write the long report')
    expect(storedRow().timeEstimateMs).toBe(45 * MINUTE)
  })

  it('takes the estimate back out when the reader picks none', async () => {
    await mountEditor(task('a', { timeEstimateMs: 2 * HOUR }))

    await chooseOption(panel(), t('todo.time.label'), t('todo.time.none'))
    await pressSave()

    expect(server.updates[0]!.patch.timeEstimate).toBeNull()
    expect(storedRow().timeEstimateMs).toBeNull()
  })

  it('refuses words that are not a duration instead of saving a plan it cannot honour', async () => {
    await mountEditor(task('a', { timeEstimateMs: 2 * HOUR }))

    typeCustom('soon')
    expect(estimateGroup().querySelector('[role="alert"]')?.textContent).toBe(t('todo.time.invalid'))
    await pressSave()

    // Nothing is written — not the estimate, not the rest of the panel: the refusal says so on the screen
    // rather than saving a row whose plan silently stayed where it was.
    expect(server.updates).toEqual([])
    expect(storedRow().timeEstimateMs).toBe(2 * HOUR)

    typeCustom('90')
    await pressSave()
    expect(storedRow().timeEstimateMs).toBe(90 * MINUTE)
  })

  it('is the shared ladder and a text field, never a native select or a number spinner', async () => {
    await mountEditor(task('a', { timeEstimateMs: HOUR }))

    expect(estimateGroup().querySelector('[aria-haspopup="menu"]')).not.toBeNull()
    expect(estimateGroup().querySelector('select')).toBeNull()
    expect(estimateGroup().querySelector('input[type="number"]')).toBeNull()
  })

  it('carries the estimate a quick-add draft named into the task it creates', async () => {
    await mountDraft({ title: 'Draft from quick add', timeEstimate: 90 * MINUTE })

    expect(selectedLabel(panel(), t('todo.time.label'))).toBe('1h 30m')
    await pressSave()

    expect(server.created).toHaveLength(1)
    expect(server.created[0]!.timeEstimate).toBe(90 * MINUTE)
  })
})
