// @vitest-environment jsdom
/**
 * The series half of the repeat field: what the panel does with a rule beyond its rhythm.
 *
 * The rhythm was already editable here, and the server has always copied it onto the next occurrence.
 * What the reader could not say was *how long* the series runs — when it stops, how many times it
 * comes back, whether this week is being let go of. R2-3 put those on the rule, and every one of them
 * reaches the row through this panel's single PATCH.
 *
 * Two properties the cases below are built around:
 *
 * - The save writes the rule **whole**. The server replaces the stored JSON with exactly what the
 *   panel sends, so a field the panel forgot is not left alone, it is deleted. `produced` is the sharp
 *   case: no control shows it, yet losing it restarts a bounded series from its first occurrence, and
 *   a row that has already run four times would run four again.
 * - Reading a rule back has to show what the row carries, because the panel is the only place a reader
 *   can see whether the series they bounded is actually bounded. A field that opens empty and then
 *   saves empty would undo the ceiling on the first unrelated title edit.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { RepeatRule, TodoTask } from '@shared/todos/model'

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
      update: async (id: string, patch: Record<string, unknown>) => {
        server.updates.push({ id, patch })
        const next = { ...server.rows.get(id)!, ...patch } as TodoTask
        server.rows.set(id, next)
        return { task: next, next: null }
      },
      create: async () => ({ task: task('made') }),
    },
  },
}))

import { TaskEditor } from './TaskEditor'
import { useTodos } from './store'

const DAY = 24 * 60 * 60 * 1000
/** Monday 2026-10-19, nine o'clock in a zone with no daylight saving to disagree about. */
const DUE = Date.parse('2026-10-19T09:00:00Z')

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: 'Write the report',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: DUE,
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

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.updates.length = 0
  server.rows.clear()
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  // The panel and its popovers are portals on the body; a leftover one would be the next case's panel.
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** Open the panel on a stored row that repeats on `rule`. */
async function mountEditor(repeat: RepeatRule | null): Promise<void> {
  const row = task('a', { repeat })
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
      dayEnd: Date.now() + DAY,
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

/** The PATCH the panel wrote, read as a rule rather than as a JSON blob. */
function savedRule(): RepeatRule | null | undefined {
  expect(server.updates).toHaveLength(1)
  return server.updates[0]!.patch.repeat as RepeatRule | null | undefined
}

function countField(): HTMLInputElement {
  const field = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.repeat.count')}"]`)
  if (!field) throw new Error('the series block offers no number of times')
  return field
}

function typeCount(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(countField(), value)
    countField().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * The series block, named the way a reader meets it.
 *
 * Scoped because the panel holds two date pickers in this region — the task's due date and the
 * series' ceiling — and both clear with a button of the same accessible name. Pressing the first one
 * in the panel would empty the due date and still report the ceiling as taken care of.
 */
function seriesGroup(): HTMLElement {
  const group = panel().querySelector<HTMLElement>(`[role="group"][aria-label="${t('todo.repeat.series')}"]`)
  if (!group) throw new Error('the repeat field shows no series group')
  return group
}

function pressButtonWithName(name: string, root: HTMLElement = panel()): void {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim().includes(name) || entry.getAttribute('aria-label') === name)
  if (!button) throw new Error(`the editor offers no control named ${name}`)
  act(() => { button.click() })
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

function checkboxState(label: string): boolean | null {
  const box = [...panel().querySelectorAll<HTMLElement>('[role="checkbox"]')]
    .find((entry) => (entry.textContent ?? '').includes(label))
  return box ? box.getAttribute('aria-checked') === 'true' : null
}

describe('the series controls', () => {
  it('open on the series the row already runs', async () => {
    await mountEditor({
      freq: 'daily',
      interval: 1,
      untilAt: Date.parse('2026-12-31T23:59:59.999Z'),
      count: 12,
      produced: 4,
      paused: true,
      fromCompletionDate: true,
      excludedDays: ['2026-10-26'],
    })

    expect(countField().value).toBe('12')
    expect(panel().textContent).toContain('2026-12-31')
    expect(checkboxState(t('todo.repeat.paused'))).toBe(true)
    expect(checkboxState(t('todo.repeat.from_completion'))).toBe(true)
    expect(panel().querySelector(`button[aria-label="${t('todo.repeat.excluded_remove', { day: '2026-10-26' })}"]`)).not.toBeNull()
  })

  it('names no series for a task that does not repeat', async () => {
    await mountEditor(null)

    // The ceiling, the pause and the skipped days all describe occurrences that will not come, so the
    // block that edits them belongs to a rhythm and is not shown for a task that has none.
    expect(panel().querySelector(`input[aria-label="${t('todo.repeat.count')}"]`)).toBeNull()
    expect(panel().textContent).not.toContain(t('todo.repeat.skip_next'))
  })

  it('writes the ceiling the reader typed beside the rhythm it belongs to', async () => {
    await mountEditor({ freq: 'daily', interval: 1 })

    typeCount('12')
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, count: 12 })
  })

  it('carries the counter no control shows, so a bounded series keeps its place', async () => {
    await mountEditor({ freq: 'daily', interval: 1, count: 12, produced: 4 })

    // Not one series control was touched: this is the ordinary edit of an ordinary title, and the
    // counter has to survive it, because the series the reader bounded is bounded by that number.
    const title = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(title!, 'Write the long report')
      title!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, count: 12, produced: 4 })
  })

  it('keeps the pause and the anchor the row was opened on', async () => {
    await mountEditor({ freq: 'weekly', interval: 1, weekdays: [1, 3], paused: true, fromCompletionDate: true })

    await pressSave()

    expect(savedRule()).toEqual({
      freq: 'weekly',
      interval: 1,
      weekdays: [1, 3],
      paused: true,
      fromCompletionDate: true,
    })
  })

  it('clears a ceiling the reader took the number out of', async () => {
    await mountEditor({ freq: 'daily', interval: 1, count: 12 })

    typeCount('')
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1 })
  })

  it('stops a pause the reader un-ticked', async () => {
    await mountEditor({ freq: 'daily', interval: 1, paused: true, count: 5 })

    pressButtonWithName(t('todo.repeat.paused'))
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, count: 5 })
  })

  it('takes the end date back out with the picker the field already shows', async () => {
    await mountEditor({ freq: 'daily', interval: 1, untilAt: Date.parse('2026-12-31T23:59:59.999Z') })

    pressButtonWithName(t('preview.kanban_clear_date'), seriesGroup())
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1 })
    // The other picker in the same region still answers for the row it belongs to.
    expect(String(server.updates[0]!.patch.dueAt)).toContain('2026-10-19')
  })

  // The day is the one the *next* occurrence lands on, found by running the rule the panel would save
  // — not today's date, which is a different day whenever the task is owed further out.
  it('lets go of the day the next occurrence would land on', async () => {
    await mountEditor({ freq: 'daily', interval: 1 })

    pressButtonWithName(t('todo.repeat.skip_next'))
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, excludedDays: ['2026-10-20'] })
  })

  it('counts from the day the reader finishes when the anchor is ticked', async () => {
    await mountEditor({ freq: 'daily', interval: 1, fromCompletionDate: true })

    pressButtonWithName(t('todo.repeat.skip_next'))
    await pressSave()

    const rule = savedRule()
    expect(rule?.excludedDays).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)])
    // Anchored on today rather than on the stored due date, which is a fortnight of Mondays back.
    expect(rule?.excludedDays?.[0]).not.toBe('2026-10-20')
  })

  it('takes a skipped day back out without touching the rest of the series', async () => {
    await mountEditor({ freq: 'daily', interval: 1, count: 3, excludedDays: ['2026-10-20', '2026-10-21'] })

    pressButtonWithName(t('todo.repeat.excluded_remove', { day: '2026-10-20' }))
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, count: 3, excludedDays: ['2026-10-21'] })
  })

  it('skips one day only once, however many times the button is pressed', async () => {
    await mountEditor({ freq: 'daily', interval: 1 })

    pressButtonWithName(t('todo.repeat.skip_next'))
    pressButtonWithName(t('todo.repeat.skip_next'))
    await pressSave()

    expect(savedRule()).toEqual({ freq: 'daily', interval: 1, excludedDays: ['2026-10-20'] })
  })

  it('names no native control the panel was not allowed to reach for', async () => {
    await mountEditor({ freq: 'weekly', interval: 1 })

    expect(panel().querySelector('select')).toBeNull()
    // The rhythm's own interval box predates this card and shares the field; the series joins it with
    // the same `Input`, so the only number fields in the repeat block are the two that belong there.
    expect(panel().querySelectorAll('input[type="number"]')).toHaveLength(2)
  })
})
