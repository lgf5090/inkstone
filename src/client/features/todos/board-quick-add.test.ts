// @vitest-environment jsdom
/**
 * Quick-add on the board: one line of prose in, one task out.
 *
 * The parser already answers what a line meant; what these cases pin is the wiring that could quietly
 * lose that answer — the chips a reader reads before pressing Enter, and the body the create route
 * actually receives. A preview that says "15:00" over a request that carries only a title would be
 * worse than no preview at all, so the assertion is made at the API boundary.
 *
 * The clock is fixed and the account zone is Shanghai, so `ming tian xia wu 3 dian` resolves to one
 * instant on every machine. The line is written in Han characters because that is the input the
 * parser was built for; `check-i18n.mjs` skips test files.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TaskList, TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
  listCreates: [] as Record<string, unknown>[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      create: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        return { task: row(String(body.title), body.listId as string | null) }
      },
      createList: async (body: Record<string, unknown>) => {
        service.listCreates.push(body)
        return { list: list('new-list', String(body.name)) }
      },
      list: async () => ({
        tasks: [], total: 0, counts: counts(), dayEnd: Date.now() + 3_600_000, timezone: 'Asia/Shanghai',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { BoardView } from './BoardView'
import { useTodos } from './store'

/** 01:30 on Tuesday 2026-10-20 in Shanghai, which is still Monday in London. */
const NOW = Date.parse('2026-10-19T17:30:00Z')

function list(id: string, name: string): TaskList {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 }
}

function counts(): TaskCounts {
  return {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0,
    byList: { L1: { open: 0, done: 0 } }, byTag: {},
  }
}

function row(title: string, listId: string | null): TodoTask {
  return {
    id: 'created', title, description: '', status: 'todo', priority: 'medium',
    dueAt: null, remindAt: null, completedAt: null, createdAt: 0, updatedAt: 0,
    listId, tags: [], starred: false, repeat: null, remindedAt: null,
    plannedFor: null,
    noteId: null, conversationId: null, projectId: null, stepTotal: 0, stepDone: 0,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

function card(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)
  if (!found) throw new Error(`no card named ${name}`)
  return found
}

function openAdd(section: HTMLElement): HTMLInputElement {
  const button = [...section.querySelectorAll('button')]
    .find((node) => (node.textContent ?? '').includes(t('todo.action.add_task')))
  if (!button) throw new Error('the card offers no add row')
  act(() => { button.click() })
  const input = section.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.action.add_task')}"]`)
  if (!input) throw new Error('the add row has no field')
  return input
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    input.focus()
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function preview(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('[data-todo-quickadd-chips]')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.creates.length = 0
  service.listCreates.length = 0
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    tasks: [],
    completed: [],
    lists: [list('L1', '工作')],
    tags: [],
    counts: counts(),
    dayEnd: NOW + 86_400_000,
    timezone: 'Asia/Shanghai',
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  view = renderElement(createElement(BoardView, { onOpenList: () => {} }))
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the board\u2019s inline quick add', () => {
  it('sends the words it understood, not only the words it left', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '明天下午3点 交周报 #工作 !2 @工作 提前15分钟提醒')

    const chips = preview(section)
    expect(chips, 'the preview the reader checks before pressing Enter is gone').not.toBeNull()
    expect(chips!.getAttribute('aria-label')).toBe(t('todo.quickadd.preview'))
    expect(chips!.textContent).toContain('15:00')
    expect(chips!.textContent).toContain(t('todo.priority.high'))
    expect(chips!.textContent).toContain('#工作')
    expect(chips!.textContent).toContain('@工作')

    await pressEnter(input)

    expect(service.creates).toHaveLength(1)
    const body = service.creates[0]!
    expect(body.title).toBe('交周报')
    expect(body.listId).toBe('L1')
    // 15:00 on 2026-10-21 in Shanghai, written as the instant the route stores.
    expect(body.dueAt).toBe(Date.UTC(2026, 9, 21, 7, 0))
    expect(body.priority).toBe('high')
    expect(body.tags).toEqual(['工作'])
    expect(body.remind).toBe('15m')
  })

  it('shows no preview for a line it understood nothing in', () => {
    const section = card(view!.container, '工作')
    typeInto(openAdd(section), '给花浇水')
    expect(preview(section), 'an empty preview row would claim the line was read').toBeNull()
  })

  it('keeps a rhythm it cannot read in the title and sends no repeat rule', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '每周三、五 打卡')

    expect(preview(section), 'two weekdays are not one repeat rule to preview').toBeNull()

    await pressEnter(input)
    const body = service.creates[0]!
    expect(body.title).toBe('每周三、五 打卡')
    expect('repeat' in body, 'the parser must not guess one of the two days').toBe(false)
    expect('dueAt' in body).toBe(false)
  })

  it('refuses a line with no title instead of writing a dated but nameless task', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '明天')
    expect(preview(section)?.textContent, 'the date itself was understood').not.toBe('')
    await pressEnter(input)
    expect(service.creates).toEqual([])
  })

  it('does not invent a list a typed name did not match', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '交周报 @不存在')
    expect(preview(section)?.textContent).toContain(t('todo.quickadd.list_missing'))
    await pressEnter(input)

    expect(service.listCreates, 'a mistyped list name created a second list').toEqual([])
    // The card the reader typed into is still the list the task belongs to.
    expect(service.creates[0]!.listId).toBe('L1')
  })
})
