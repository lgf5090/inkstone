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
import { useUi } from '../../store/ui'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'

const service = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
  listCreates: [] as Record<string, unknown>[],
  logged: [] as { id: string, span: { startAt: number, endAt: number } }[],
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
      /** The ledger's back-fill door: what a line's spent half is filed through. */
      addTime: async (id: string, span: { startAt: number, endAt: number }) => {
        service.logged.push({ id, span })
        return { entries: [] }
      },
      list: async () => ({
        tasks: [], total: 0, counts: counts(), dayEnd: Date.now() + 3_600_000, timezone: 'Asia/Shanghai',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: row('交周报', 'L1'), steps: [] }),
    },
  },
}))

import { BoardView } from './BoardView'
import { normalizeQuickAddInput } from '@shared/todos/quick-parse'
import { useTodos } from './store'

/** 01:30 on Tuesday 2026-10-20 in Shanghai, which is still Monday in London. */
const NOW = Date.parse('2026-10-19T17:30:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
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

/**
 * Drain the writes a single Enter sets off.
 *
 * The create is only the first of them: the spent half of a line goes on to the ledger and the row it
 * moved is read back afterwards, so the chain is three requests deep. Two microtask turns prove the
 * create landed; these prove what hung off it landed too.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  })
}

function preview(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('[data-todo-quickadd-chips]')
}

/** The painted line under the field, if the open card is wearing one. */
function mirror(section: HTMLElement): HTMLElement | null {
  return section.querySelector<HTMLElement>('[data-todo-quickadd-mirror]')
}

/** The words the mirror says were read, in the order it paints them. */
function tinted(section: HTMLElement): string[] {
  return [...(mirror(section)?.querySelectorAll('[data-quickadd-kind]') ?? [])]
    .map((node) => node.textContent ?? '')
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.creates.length = 0
  service.listCreates.length = 0
  service.logged.length = 0
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

    // F08 made a two-day rhythm expressible, so the old "must not guess" guard is now the opposite
    // contract: one weekly rule carrying both days, previewed like any other repeat.
    expect(preview(section), 'two weekdays should preview as one weekly rule').not.toBeNull()

    await pressEnter(input)
    const body = service.creates[0]!
    expect(body.title).toBe('打卡')
    expect(body.repeat).toEqual({ freq: 'weekly', interval: 1, weekdays: [3, 5] })
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

  it('paints the words it read where those words sit in the line', () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '#工作 明天下午3点 交周报')

    const layer = mirror(section)
    expect(layer, 'the line painted under the field is gone').not.toBeNull()
    // A picture of the field, not a second control: no name, no focus, nothing to press.
    expect(layer!.getAttribute('aria-hidden')).toBe('true')
    // The same words in the same order, or every band of colour sits away from the word it names.
    expect(normalizeQuickAddInput(layer!.textContent ?? '')).toBe(normalizeQuickAddInput(input.value))
    expect(tinted(section)).toEqual(['#工作', '明天', '下午3点'])

    // Two halves of one line have to wear one box: same padding, same border, same glyphs. The height is
    // the field's alone and the mirror stretches to it, because the field's height changes at a
    // breakpoint and a copy of it is a pixel of drift. The field gives up its own background to the line
    // under it, which is what keeps the caret and the selection the browser draws legible over a tint.
    for (const shared of ['px-2.5', 'border', 'rounded-[var(--r-md)]', 'text-[length:var(--text-12)]']) {
      expect(input.className, `${shared} belongs to both halves of the line`).toContain(shared)
      expect(layer!.className, `${shared} belongs to both halves of the line`).toContain(shared)
    }
    expect(input.className).toContain('h-9')
    expect(layer!.className).not.toContain('h-9')
    expect(layer!.className).toContain('inset-0')
    expect(input.className).toContain('bg-transparent')
    expect(input.className).not.toContain('var(--bg-inset)')
    expect(layer!.className).toContain('bg-[var(--bg-inset)]')
    expect(layer!.className).toContain('pointer-events-none')
  })

  it('says what it recognised in the order the words were typed', () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '#工作 明天下午3点 !2')

    const summary = section.querySelector<HTMLElement>('#todo-quickadd-summary')
    expect(summary, 'the field promises a description it never writes').not.toBeNull()
    expect(input.getAttribute('aria-describedby')).toBe('todo-quickadd-summary')
    expect(summary!.getAttribute('role')).toBe('status')
    const said = summary!.textContent ?? ''
    expect(said).toContain(t('todo.quickadd.kind.tag', { text: '#工作' }))
    expect(said).toContain(t('todo.quickadd.kind.date', { text: '明天' }))
    // The chips group by field and the parser's array follows them; a sentence has to follow the typing,
    // which puts the tag first here and the priority last.
    expect(said.indexOf(t('todo.quickadd.kind.tag', { text: '#工作' })))
      .toBeLessThan(said.indexOf(t('todo.quickadd.kind.priority', { text: '!2' })))
  })

  it('leaves a line it read nothing in unpainted and unsaid', () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '给花浇水')

    expect(tinted(section)).toEqual([])
    expect(input.getAttribute('aria-describedby')).toBeNull()
    expect(section.querySelector<HTMLElement>('#todo-quickadd-summary')?.textContent).toBe('')
  })

  it('says a filtered card has no matches instead of reading blank', () => {
    act(() => {
      useTodos.setState({
        tasks: [],
        query: '不存在',
        counts: { ...counts(), inbox: 3, all: 3 },
      })
    })
    const inbox = card(view!.container, t('todo.smart.inbox'))
    expect(inbox.textContent).toContain(t('todo.empty.search'))
    expect(inbox.textContent).not.toContain(t('todo.empty.list'))
  })

  it('sends the plan the line named as the row’s own column', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '写周报 1h20m')
    await pressEnter(input)

    expect(service.creates).toHaveLength(1)
    expect(service.creates[0]!.title).toBe('写周报')
    expect(service.creates[0]!.timeEstimate).toBe(80 * MINUTE)
    expect(service.logged, 'a line that spent nothing logged nothing').toEqual([])
  })

  it('paints the plan it read among the words of the line', () => {
    const section = card(view!.container, '工作')
    typeInto(openAdd(section), '写周报 5m/1h')

    // One band for the pair: the two halves are one answer, and cutting them apart would paint a
    // spent minute over the word that names the plan.
    expect(tinted(section)).toEqual(['5m/1h'])
  })

  it('files the spent half of a pair at the ledger door, not on the row', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '写周报 5m/1h')
    await pressEnter(input)
    await settle()

    expect(service.creates).toHaveLength(1)
    const body = service.creates[0]!
    expect(body.title).toBe('写周报')
    expect(body.timeEstimate).toBe(HOUR)
    expect(body, 'the spent half is a ledger row, not a column of the create body').not.toHaveProperty('timeLoggedMs')

    expect(service.logged).toHaveLength(1)
    expect(service.logged[0]!.id).toBe('created')
    // The line named no clock of its own, so the span is the length it said, ending at the press.
    expect(service.logged[0]!.span).toEqual({ startAt: NOW - 5 * MINUTE, endAt: NOW })
  })

  it('refuses the spent half one ledger row cannot hold, and still files the row', async () => {
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    typeInto(input, '写周报 5h/1h')
    await pressEnter(input)
    await settle()

    expect(service.creates).toHaveLength(1)
    expect(service.creates[0]!.timeEstimate).toBe(HOUR)
    expect(service.logged, 'a span past the ceiling was sent to the ledger anyway').toEqual([])
    const said = useUi.getState().toasts.map((entry) => entry.title)
    expect(said, 'the refusal was swallowed instead of said').toContain(t('todo.time.logged_refused'))
  })
})
