// @vitest-environment jsdom
/**
 * What a row says about its note, in the note's own words.
 *
 * The description is Markdown — the editor writes it and the preview renders it — and the row printed it
 * as a substring, so a note opening with a heading and two bullets reached the listing with the author's
 * `##` and `-` still on it. That syntax read as content, and it was the sentence a screen reader was
 * handed too. The row now reads the same plain text the search index and the assistant read, and still
 * hands it over as a text node, which is what keeps a note from ever being markup here.
 *
 * A note that turns into nothing once its markup is gone says nothing on the row either — and the row's
 * own press stops describing a line that was never drawn, because a reference to an absent id is a
 * thing a screen reader is told to look for.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: counts(), dayEnd: NOW + 86_400_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
    },
  },
}))

import { TaskCard } from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-19T09:00:00Z')

function counts(): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
}

function row(extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id: 'a',
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

let view: RenderedElement | null = null

function mount(task: TodoTask): HTMLElement {
  view = renderElement(createElement(TaskCard, {
    task,
    lists: [],
    bounds: { dayEnd: NOW + 86_400_000, now: NOW },
    timezone: 'UTC',
    onOpen: () => {},
  }))
  return view.container
}

/** The row's own press, and what it tells a screen reader to read beside it. */
function described(container: HTMLElement): string[] {
  const body = container.querySelector('[data-todo-details]')
  return (body?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
}

/** The note line the row drew, if it drew one. */
function notesLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-todo-notes]')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState({
    status: 'ready',
    tasks: [] as TodoTask[],
    completed: [] as TodoTask[],
    lists: [],
    tags: [],
    counts: counts(),
    selectedIds: new Set<string>(),
    dayEnd: NOW + 86_400_000,
    timezone: 'UTC',
  })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the note a row shows', () => {
  it('says the words of a headed, bulleted note and none of its syntax', () => {
    const container = mount(row({ description: '## 要点\n\n- 三条结论\n- 一张图' }))
    const notes = notesLine(container)
    expect(notes, 'the row drew no note').not.toBeNull()
    expect(notes!.textContent).toBe('要点 三条结论 一张图')
    expect(notes!.textContent).not.toMatch(/[#*_`~-]\s/)
  })

  it('keeps the note a text node, so none of it can be markup', () => {
    const container = mount(row({ description: '# Heading\n\n<b>bold</b> and [the docs](https://example.com)' }))
    const notes = notesLine(container)!
    expect(notes.children.length).toBe(0)
    expect(container.querySelectorAll('a').length).toBe(0)
    expect(notes.textContent).not.toContain('<b>')
    expect(notes.textContent).toContain('the docs')
  })

  it('draws a plain sentence exactly as it was written', () => {
    const container = mount(row({ description: 'Bring the signed folder from the office' }))
    expect(notesLine(container)!.textContent).toBe('Bring the signed folder from the office')
  })

  it('draws no line at all for a note that is only markup', () => {
    const container = mount(row({ description: '---' }))
    expect(notesLine(container)).toBeNull()
    // And the row stops describing a line it did not draw: the meta line is all that is left to hear.
    const ids = described(container)
    expect(ids.length).toBe(1)
    expect(container.querySelector(`[id="${ids[0]}"]`)).not.toBeNull()
  })

  it('says nothing for a note that is empty, as it always did', () => {
    const container = mount(row({ description: '' }))
    expect(notesLine(container)).toBeNull()
  })
})
