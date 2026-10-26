// @vitest-environment jsdom
/**
 * The other door into a task: the palette command and the editor it opens.
 *
 * The command has to keep working with no argument at all — that is what the palette and a macro
 * step call — and, when something does hand it a line, it must be the parsed draft that the editor
 * opens on rather than the raw sentence. The editor is rendered as well, because a draft that
 * parses correctly and then loses its reminder on the way into the form is still a broken entry.
 *
 * The save is driven here too, because the panel rebuilds its body from its own fields and a draft
 * field no field owns is a draft field the form can silently drop. The spent half of `5m/1h` is
 * exactly such a field: it is a ledger span rather than a column of the row, so the only proof it
 * survived this door is the request the ledger received.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { selectedLabel } from '../../lib/test-menu'
import { api, type TaskListEntry } from '../../lib/api'
import type { TodoTask } from '@shared/todos/model'
// The export helpers pull KaTeX's stylesheet in with `?inline`, which Vite refuses to read through
// this checkout's symlinked `node_modules`; nothing under test exports a note, so the module is a stub.
vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))

import { findAppCommand, runAppCommand } from '../command/registry'
import { useTodos } from './store'
import { TaskEditor } from './TaskEditor'

const NOW = Date.parse('2026-10-19T17:30:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
}

/** A row shaped the way the create route answers, so the store can put it on the board. */
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
    createdAt: NOW,
    updatedAt: NOW,
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

/** The counts read the store asks for after a landed write; the numbers themselves are not under test. */
function emptyPage() {
  return {
    tasks: [] as TodoTask[],
    total: 0,
    counts: {
      inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
    },
    dayEnd: NOW + 86_400_000,
    timezone: 'Asia/Shanghai',
  }
}

/** Let the panel's own first reads land before a case presses a control. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/**
 * Press the panel's Save and let both writes settle.
 *
 * A line with a spent half is two requests — the row, then the span the ledger is filed with — and the
 * second is followed by the read that repaints the row, so one macrotask is not enough to see it.
 */
async function pressSave(): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the editor offers no save button')
  await act(async () => {
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState(original, true)
  useTodos.setState({ lists: [list('L1', '工作')], timezone: 'Asia/Shanghai' })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  window.history.replaceState(null, '', '/notes')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  window.history.replaceState(null, '', '/notes')
})

describe('the new-task command', () => {
  it('is still registered and still opens an empty editor with no argument', () => {
    expect(findAppCommand('cmd-new-todo'), 'the palette lost its new-task command').not.toBeNull()
    expect(runAppCommand('cmd-new-todo')).toEqual({ ok: true })
    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().draft).toEqual({})
  })

  it('opens the editor on the draft a line describes', () => {
    expect(runAppCommand('cmd-new-todo', '明天下午3点 交周报 #工作 !2 @工作 提前15分钟提醒')).toEqual({ ok: true })

    const draft = useTodos.getState().draft!
    expect(draft.title).toBe('交周报')
    expect(draft.listId).toBe('L1')
    expect(draft.dueAt).toBe(Date.UTC(2026, 9, 21, 7, 0))
    expect(draft.priority).toBe('high')
    expect(draft.tags).toEqual(['工作'])
    expect(draft.remindAt).toBe(Date.UTC(2026, 9, 21, 7, 0) - 15 * 60_000)
  })

  it('prefills the form from that draft, including the reminder', () => {
    runAppCommand('cmd-new-todo', '明天下午3点 交周报 #工作 !2 @工作 提前15分钟提醒')
    view = renderElement(createElement(TaskEditor))

    const title = document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
    expect(title?.value).toBe('交周报')

    // Priority is a radio group, and the list and the reminder are select-menus: each is read the way
    // a reader reads it — the pressed radio's word, and the trigger's own label.
    const pressed = [...document.querySelectorAll<HTMLElement>('[role="radio"][aria-checked="true"]')]
      .map((node) => (node.textContent ?? '').trim())
    expect(pressed).toContain(t('todo.priority.high'))
    expect(selectedLabel(document.body, t('todo.task.list_label'))).toBe('工作')
    expect(selectedLabel(document.body, t('todo.task.reminder_preset')), 'the reminder was parsed but lost before the form').toBe(t('todo.remind.15m'))
  })

  it('carries the plan a line names into the draft and the form', () => {
    expect(runAppCommand('cmd-new-todo', '写周报 1h20m')).toEqual({ ok: true })
    const draft = useTodos.getState().draft!
    expect(draft.title).toBe('写周报')
    expect(draft.timeEstimate).toBe(80 * 60_000)
    expect(draft.timeLoggedMs, 'a line that named no pair spent nothing').toBeUndefined()

    // One hour is a rung of the ladder the picker offers, so the form can be read back as the word a
    // reader would say rather than as a number in a box.
    runAppCommand('cmd-new-todo', '写周报 1h')
    view = renderElement(createElement(TaskEditor))
    expect(selectedLabel(document.body, t('todo.time.label'))).toBe('1h')
  })

  it('holds the spent half of a pair apart from the row the editor writes', () => {
    expect(runAppCommand('cmd-new-todo', '写周报 5m/1h')).toEqual({ ok: true })
    const draft = useTodos.getState().draft!
    expect(draft.timeEstimate).toBe(60 * 60_000)
    // The five minutes are a fact about the ledger rather than a column of the row: the draft carries it
    // for `createTask` to file, and no field of the form owns it.
    expect(draft.timeLoggedMs).toBe(5 * 60_000)
  })

  it('files the spent half of a pair through the door the palette saves at', async () => {
    const made = row('made', { title: '写周报', timeEstimateMs: HOUR })
    const create = vi.spyOn(api.todos, 'create').mockResolvedValue({ task: made })
    const logged = vi.spyOn(api.todos, 'addTime').mockResolvedValue({ entries: [] })
    vi.spyOn(api.todos, 'get').mockResolvedValue({ task: made, steps: [] })
    vi.spyOn(api.todos, 'list').mockResolvedValue(emptyPage())

    expect(runAppCommand('cmd-new-todo', '写周报 5m/1h')).toEqual({ ok: true })
    view = renderElement(createElement(TaskEditor))
    await flush()
    await pressSave()

    // The same door the board's inline enter uses: the plan is a column of the create body, the spent
    // half is a span at the ledger, and the panel rebuilds neither out of its own fields.
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).not.toHaveProperty('timeLoggedMs')
    expect(logged.mock.calls, 'the hours the line named never reached the ledger').toEqual([
      ['made', { startAt: NOW - 5 * MINUTE, endAt: NOW }],
    ])
  })
})
