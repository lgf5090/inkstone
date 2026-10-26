// @vitest-environment jsdom
/**
 * What a board card's header owes, and what it should keep quiet about.
 *
 * The fraction beside a list's name answers "how much of this is done". A list with no rows has not asked
 * that question, and `0/0` in the place a real ratio would sit reads as a number rather than as an empty
 * collection, and the card's own body already says the list is empty in the reader's language. The mark
 * appears the moment there is a row to divide, and counts finished work in the denominator the way it
 * always has.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'
import { useTodos } from './store'
import { BoardView } from './BoardView'

const service = vi.hoisted(() => ({ rows: [] as TodoTask[], lists: [] as TaskListEntry[] }))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: service.rows,
        total: service.rows.length,
        counts: { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} } as TaskCounts,
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: [] }),
      counts: async () => ({ counts: service.rows.length ? {} : {}, dayEnd: 0, timezone: 'UTC' }),
    },
  },
}))

function list(id: string, name: string, open = 0, done = 0): TaskListEntry {
  return {
    id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0,
    openCount: open, doneCount: done, archivedAt: null, parentId: null,
  }
}

function task(id: string, listId: string | null): TodoTask {
  return {
    id, title: `T${id}`, description: '', status: 'todo', priority: 'medium',
    dueAt: null, startAt: null, remindAt: null, listId, tags: [], starred: false,
    repeat: null, createdAt: 0, updatedAt: 0, completedAt: null, abandonedAt: null,
    rev: 1, stepDone: 0, stepTotal: 0, timeEstimateMs: null, timeSpentMs: 0,
    runningSince: null, archivedAt: null, color: null, icon: null,
  } as unknown as TodoTask
}

let view: RenderedElement | null = null

async function draw(): Promise<string> {
  view = renderElement(createElement(BoardView, { onOpenList: () => {} }))
  await act(async () => {
    useTodos.setState({ status: 'ready', tasks: service.rows, lists: service.lists, counts: null })
  })
  return view.container.textContent ?? ''
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  view = null
})

describe("a card's header", () => {
  it('keeps the fraction off an empty list', async () => {
    service.lists = [list('l1', '空的清单')]
    service.rows = []
    const text = await draw()
    expect(text).toContain('空的清单')
    expect(text).not.toContain('0/0')
  })

  it('prints the fraction as soon as there is a row to divide', async () => {
    // The fraction is the list's own counts, which the server answers with; the page's rows are what the
    // card draws under it, and the two are different readings of the same list.
    service.lists = [list('l1', '有货的清单', 1, 0)]
    service.rows = [task('t1', 'l1')]
    const text = await draw()
    expect(text).toContain('0/1')
    expect(text).not.toContain('0/0')
  })
})
