/**
 * Three kanban controls named themselves in a language the reader may not speak: a tag chip's remove
 * button borrowed the *mindmap* shortcut string, a subtask's completion toggle was the literal
 * `'Mark complete'`, and the progress bar's catch-all segment was the literal `'Other'`. Both label
 * probes that already existed pass on all three — the name is present, and nothing was concatenated —
 * so each case mounts the real surface once per shipped language and requires the phrase to be the
 * kanban resource's own entry for that action, with the thing it acts on named inside the message.
 */
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { KanbanItem, KanbanProperty } from '../types'
import { KanbanCard } from './kanban-card'
import { DetailDescription, KANBAN_DESCRIPTION_MAX_CHARS } from './kanban-item-detail-description'
import { KanbanProgressBar } from './kanban-progress-bar'
import { KanbanSubtaskList } from './kanban-subtask-list'
import { KanbanTagPicker } from './kanban-tag-picker'
import {
  installBilingualLabelHooks,
  LOCALES,
  type LocaleCode,
  messageIn,
  mountIn,
} from './kanban-bilingual-labels.test-helpers'

installBilingualLabelHooks()

describe('a tag chip says which tag it removes', () => {
  async function removeButton(code: LocaleCode): Promise<HTMLElement | null> {
    const container = await mountIn(code, createElement(KanbanTagPicker, {
      tags: ['x'],
      options: [{ id: 'x', label: 'Spec', color: 'green' }],
      onChangeTags: vi.fn(),
    }))
    return container.querySelector<HTMLElement>('button[aria-label]')
  }

  it.each(LOCALES)('uses the kanban resource in %s', async (code) => {
    const button = await removeButton(code)
    expect(button, 'the tag chip renders no remove control').not.toBeNull()
    expect(button!.getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_remove_tag_named', { name: 'Spec' }),
    )
  })
})

describe('the subtask completion toggle', () => {
  const subtasks = [
    { id: 's1', title: 'Draft the outline', completed: false },
    { id: 's2', title: 'Review it', completed: true },
  ]

  async function toggles(code: LocaleCode): Promise<HTMLElement[]> {
    const container = await mountIn(code, createElement(KanbanSubtaskList, {
      subtasks,
      onUpdateSubtasks: vi.fn(),
    }))
    return [...container.querySelectorAll<HTMLElement>('button[aria-label]')]
  }

  it.each(LOCALES)('names both states after the subtask in %s', async (code) => {
    const found = await toggles(code)
    const open = found.find((el) => el.getAttribute('aria-label')?.includes('Draft the outline'))
    const done = found.find((el) => el.getAttribute('aria-label')?.includes('Review it'))
    expect(open, 'nothing names the incomplete subtask').not.toBeUndefined()
    expect(done, 'nothing names the completed subtask').not.toBeUndefined()
    expect(open!.getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_mark_complete_named', { name: 'Draft the outline' }),
    )
    expect(done!.getAttribute('aria-label')).toBe(
      messageIn(code, 'preview.kanban_mark_incomplete_named', { name: 'Review it' }),
    )
  })
})

describe('a missed deadline on a card', () => {
  const TODAY = new Date(2026, 2, 15)
  const lateItem: KanbanItem = { id: 'late', title: 'Ship the spec', properties: { status: 'todo', dueDate: '2026-03-12' } }
  const lateColumns: KanbanProperty[] = [
    { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
  ]

  async function badge(code: LocaleCode): Promise<HTMLElement | null> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TODAY)
    try {
      const container = await mountIn(code, createElement(KanbanCard, {
        item: lateItem,
        columns: lateColumns,
        isSelected: false,
        onToggleSelect: vi.fn(),
        onOpenDetail: vi.fn(),
        onUpdateTitle: vi.fn(),
        onDragStart: vi.fn(),
        onDragEnd: vi.fn(),
      }))
      return container.querySelector<HTMLElement>('[data-kanban-date]')
    }
    finally {
      vi.useRealTimers()
    }
  }

  it.each(LOCALES)('says how late it is in %s instead of leaning on the colour', async (code) => {
    const found = await badge(code)
    expect(found, 'the card draws no date badge').not.toBeNull()
    expect(found!.textContent).toBe(messageIn(code, 'preview.kanban_overdue_days', { count: 3 }))
  })
})

describe("the progress bar's catch-all segment", () => {
  const statusColumn: KanbanProperty = {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'todo', label: 'To Do', color: 'gray' }],
  }
  const items: KanbanItem[] = [
    { id: 'a', title: 'Planned', properties: { status: 'todo' } },
    { id: 'b', title: 'Unfiled', properties: { status: 'archived' } },
  ]

  async function titles(code: LocaleCode): Promise<string[]> {
    const container = await mountIn(code, createElement(KanbanProgressBar, {
      items,
      statusColumn,
    }))
    return [...container.querySelectorAll<HTMLElement>('[title]')].map((el) => el.getAttribute('title') ?? '')
  }

  it.each(LOCALES)('names itself in the reader language in %s while a group keeps its own name', async (code) => {
    const found = await titles(code)
    expect(found, 'the bar draws no segment').not.toHaveLength(0)
    expect(
      found.some((title) => title.startsWith(messageIn(code, 'preview.kanban_status_other'))),
      `no segment is named after the reader language: ${found.join(' | ')}`,
    ).toBe(true)
    expect(
      found.some((title) => title.startsWith('To Do')),
      'a board-authored group name got translated away',
    ).toBe(true)
  })
})

describe('the description box length feedback', () => {
  async function mounted(code: LocaleCode): Promise<HTMLElement> {
    return mountIn(code, createElement(DetailDescription, {
      content: 'Some body',
      onChange: vi.fn(),
    }))
  }

  it.each(LOCALES)('names both expander states in %s', async (code) => {
    const container = await mounted(code)
    const expander = container.querySelector<HTMLElement>('[aria-expanded]')
    expect(expander, 'the description box draws no expander').not.toBeNull()
    expect(expander!.getAttribute('aria-label')).toBe(messageIn(code, 'preview.kanban_expand_description'))
    await act(async () => { expander!.click() })
    expect(expander!.getAttribute('aria-label')).toBe(messageIn(code, 'preview.kanban_collapse_description'))
  })

  it.each(LOCALES)('counts characters with one message in %s', async (code) => {
    const container = await mounted(code)
    const box = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(box, 'the description box is missing').not.toBeNull()
    const typed = 'a'.repeat(KANBAN_DESCRIPTION_MAX_CHARS - 100)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box!, typed)
      box!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const counter = container.querySelector<HTMLElement>('[data-kanban-desc-count]')
    expect(counter, 'the near-limit description draws no counter').not.toBeNull()
    expect(counter!.textContent).toBe(
      messageIn(code, 'preview.kanban_desc_count', { count: typed.length, limit: KANBAN_DESCRIPTION_MAX_CHARS }),
    )
  })
})
