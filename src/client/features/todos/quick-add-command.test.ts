// @vitest-environment jsdom
/**
 * The other door into a task: the palette command and the editor it opens.
 *
 * The command has to keep working with no argument at all — that is what the palette and a macro
 * step call — and, when something does hand it a line, it must be the parsed draft that the editor
 * opens on rather than the raw sentence. The editor is rendered as well, because a draft that
 * parses correctly and then loses its reminder on the way into the form is still a broken entry.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { selectedLabel } from '../../lib/test-menu'
import type { TaskListEntry } from '../../lib/api'
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

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
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
})
