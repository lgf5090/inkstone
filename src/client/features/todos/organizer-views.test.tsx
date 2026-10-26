// @vitest-environment jsdom
/**
 * The organizer page's view list is the navigation table, not a copy of it.
 *
 * The section used to name two of the ten surfaces by hand — the plan and the finished list — and read as
 * though it were the whole set. That is the shape of bug a hand-maintained second list always reaches: a surface added to
 * the table never appears here, and nothing goes red to say so. These cases ask the rendered page and the
 * table for the same answer in both directions, so the day a row is dropped or a surface is added without
 * this section following, a named test fails.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { DEFAULT_TODO_WORKDAY } from '@shared/constants'
import type { TaskCounts } from '@shared/todos/model'
import { useSession } from '../../store/session'
import { useTodos } from './store'
import { surfacesFor } from './views/nav'
import { ListsView } from './ListsView'

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: null, dayEnd: 0, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
    },
  },
}))

vi.mock('../settings/sections', () => ({ warmSettingsSection: vi.fn() }))

let view: RenderedElement | null = null

const COUNTS = {
  inbox: 0, today: 3, upcoming: 2, overdue: 0, all: 9, completed: 4, starred: 1, byList: {}, byTag: {},
} as unknown as TaskCounts

async function draw(finishDayEnabled: boolean): Promise<string[]> {
  view = renderElement(createElement(ListsView, { onOpen: () => {} }))
  await act(async () => {
    useSession.setState({
      settings: {
        ...useSession.getState().settings,
        todo: { ...useSession.getState().settings.todo, workday: { ...DEFAULT_TODO_WORKDAY, finishDayEnabled } },
      },
    })
    useTodos.setState({ status: 'ready', counts: COUNTS, lists: [], tags: [] })
  })
  const section = [...(view?.container.querySelectorAll('section') ?? [])]
    .find((el) => el.querySelector('h2')?.textContent === t('todo.lists.views'))
  // The label alone: the badge digit rides in the same button, and comparing it here would test the
  // aggregate rather than the row set. The badge is asserted separately below.
  return [...(section?.querySelectorAll('button') ?? [])]
    .map((button) => button.querySelector('span.flex-1')?.textContent?.trim() ?? '')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  view = null
})

describe('the organizer page’s view rows', () => {
  for (const finishDayEnabled of [true, false]) {
    it(`offers exactly the sidebar's surfaces when the close-out is ${finishDayEnabled ? 'on' : 'off'}`, async () => {
      const rows = await draw(finishDayEnabled)
      const expected = surfacesFor('sidebar', { finishDayEnabled }).map((surface) => t(surface.sidebar!.labelKey))
      expect(rows).toEqual(expected)
      // The hand-written pair this replaces; a section that still only knew these is the regression.
      expect(rows.length).toBe(expected.length)
      expect(rows.length).toBeGreaterThan(2)
    })
  }

  it('still draws the badge beside the row it counts', async () => {
    await draw(true)
    const section = [...(view?.container.querySelectorAll('section') ?? [])]
      .find((el) => el.querySelector('h2')?.textContent === t('todo.lists.views'))
    // `today: 3` in the fixture; the today row is the one that carries it.
    expect(section?.textContent).toContain('3')
  })

  it('names 计划 and 已完成, the two the section used to be the only way to', async () => {
    const rows = await draw(true)
    expect(rows).toContain(t('todo.view.plan'))
    expect(rows).toContain(t('todo.smart.completed'))
  })
})
