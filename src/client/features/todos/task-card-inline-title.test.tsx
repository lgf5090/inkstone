// @vitest-environment jsdom
/**
 * Renaming a task where it is read, and the drag that has to stay out of the way.
 *
 * C2 was the extra layer: changing a title meant opening the editor, and the plan's whole argument for
 * removing it is that a row already shows the title the reader means to change. Two things make that
 * safe rather than a trap, and both are pinned here.
 *
 * The first is the gesture. The row is draggable, so a press on the title is either "edit this" or
 * "move this", and the difference is how far the pointer travelled: under the threshold a release is a
 * tap and opens the box, over it the press was a drag and must open nothing. The other direction is
 * the row's own claim — while the box is open the row must not be draggable, or selecting text inside
 * the field would drag the task out of its list.
 *
 * The second is what the row still does. A tap on the title is no longer the way into the task, so the
 * body keeps its own control for that, and the box's three exits (Enter, Escape, leaving the field)
 * are each asserted against the request the store made — a box that looks committed but wrote nothing
 * is the failure this surface cannot have.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

const server = vi.hoisted(() => ({
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}))

vi.mock('../../lib/api', () => {
  const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
  return {
    api: {
      todos: {
        update: async (id: string, patch: Record<string, unknown>) => {
          server.updates.push({ id, patch })
          return { task: { ...row(id, 'Write the report'), ...(patch as Partial<TodoTask>) }, next: null }
        },
        list: async () => ({ tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      },
    },
  }
})

import { TaskCard, type TaskMoveControls } from './TaskCard'
import { dueLabel } from './todo-ui'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
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

/** A row a fine pointer can drag: the case the threshold has to arbitrate. */
function moveControls(): TaskMoveControls {
  return {
    dragEnabled: true,
    onDrop: vi.fn(),
    order: { up: true, down: true, moveUp: vi.fn(), moveDown: vi.fn() },
    onMoveToList: vi.fn(),
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null
let opened = 0

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.updates.length = 0
  opened = 0
  useTodos.setState(original, true)
  useTodos.setState({ lists: [], timezone: 'UTC', dayEnd: NOW + DAY, selectedIds: new Set<string>() })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.unstubAllGlobals()
})

function mount(task: TodoTask, move: TaskMoveControls | undefined = moveControls()): void {
  useTodos.setState({ tasks: [task], completed: [], total: 1 })
  view = renderElement(createElement(TaskCard, {
    task,
    lists: [],
    bounds: { dayEnd: NOW + DAY, now: NOW },
    timezone: 'UTC',
    onOpen: () => { opened += 1 },
    onStar: () => {},
    move,
  }))
}

/** The row's title control — the element the caret stands on, and the one a tap edits. */
function titleTrigger(): HTMLButtonElement {
  const node = view!.container.querySelector<HTMLButtonElement>('[data-todo-open]')
  if (!node) throw new Error('the row draws no title control')
  return node
}

/** The control that still takes the reader into the task itself. */
function detailsTrigger(): HTMLButtonElement {
  const node = view!.container.querySelector<HTMLButtonElement>('[data-todo-details]')
  if (!node) throw new Error('the row offers no way to open the task')
  return node
}

function field(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
}

function press(node: Element | null | undefined, event: Event = new MouseEvent('click', { bubbles: true, cancelable: true })): void {
  expect(node, 'the element is not rendered').toBeTruthy()
  act(() => { node!.dispatchEvent(event) })
}

function pointer(node: Element, type: string, x: number, y: number): void {
  act(() => { node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse' })) })
}

/** What a reader types: the React-controlled value, not the attribute. */
function typeField(value: string): void {
  const input = field()
  expect(input, 'the row opened no title field').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(node: Element, keyName: string): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
  })
}

/** Let the write and its reload run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

describe('a tap on the title', () => {
  it('opens an inline field on the row rather than the editor', () => {
    mount(row('a', 'Write the report'))

    press(titleTrigger())

    expect(field(), 'the tap opened no title field').not.toBeNull()
    expect(field()!.value).toBe('Write the report')
    expect(opened, 'a tap on the title still jumped into the editor').toBe(0)
    expect(document.activeElement, 'the caret did not land in the field').toBe(field())
  })

  it('names the field for a screen reader', () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    expect(field()!.getAttribute('aria-label')).toBe(t('todo.task.title_label'))
  })

  it('sends the new title on Enter, and hands focus back to the row', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    typeField('Send the report')
    key(field()!, 'Enter')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { title: 'Send the report' } }])
    expect(field(), 'the field stayed open after Enter').toBeNull()
    expect(document.activeElement, 'focus was not returned to the row').toBe(titleTrigger())
  })

  it('takes Enter as a commit rather than a newline the browser would act on', () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    // A keystroke that reaches the row's own activation would open the editor: the field has to cancel it.
    let handled = true
    act(() => {
      handled = field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(handled, 'the field left Enter for the row to answer').toBe(false)
  })

  it('writes nothing on Escape and puts the old title back', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    typeField('half typed')
    key(field()!, 'Escape')
    await settle()

    expect(server.updates, 'Escape still wrote').toEqual([])
    expect(field(), 'Escape left the field open').toBeNull()
    expect(titleTrigger().textContent).toBe('Write the report')
    expect(document.activeElement).toBe(titleTrigger())
  })

  it('commits when the reader simply leaves the field', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    typeField('Review the draft')
    // React hears a leaving field as the bubbling `focusout`, which is what a real blur becomes.
    act(() => { field()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { title: 'Review the draft' } }])
  })

  it('refuses to write an empty title', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    typeField('   ')
    key(field()!, 'Enter')
    await settle()

    expect(server.updates, 'a blank title reached the server').toEqual([])
    expect(field()).toBeNull()
    expect(titleTrigger().textContent).toBe('Write the report')
  })

  it('sends nothing when the reader changed nothing', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    key(field()!, 'Enter')
    await settle()

    expect(server.updates).toEqual([])
  })

  it('is not a way to open the task: the body still is', () => {
    mount(row('a', 'Write the report'))

    press(detailsTrigger())

    expect(opened, 'the row lost its way into the task').toBe(1)
    expect(field()).toBeNull()
  })

  it('keeps what the row says attached to the control that opens the task', () => {
    const task = row('a', 'Write the report', { status: 'in_progress', dueAt: Date.UTC(2026, 9, 21, 23, 59) })
    mount(task)
    const details = detailsTrigger()

    // The control is a name of its own, which replaces the text it sits on rather than adding to it, so
    // the row's own words have to come along as its description.
    expect(details.getAttribute('aria-label')).toBe(t('todo.a11y.open_task', { title: 'Write the report' }))
    const described = (details.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(described).toContain(t('todo.status.in_progress'))
    const due = dueLabel(task.dueAt, { dayEnd: NOW + DAY, now: NOW }, 'UTC')
    expect(due, 'the row shows no day at all').not.toBeNull()
    expect(described).toContain(due!.text)
  })

  it('answers the keyboard Enter the same way it answers the tap', () => {
    mount(row('a', 'Write the report'))
    act(() => { titleTrigger().focus() })

    // A button activated from the keyboard arrives as a click with no pointer coordinates at all.
    press(titleTrigger(), new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))

    expect(field(), 'Enter did not open the title field').not.toBeNull()
    expect(opened).toBe(0)
  })
})

describe('the drag and the field', () => {
  it('reads a press that travelled as the drag it was, and opens no field', () => {
    mount(row('a', 'Write the report'))
    const title = titleTrigger()

    pointer(title, 'pointerdown', 10, 10)
    pointer(title, 'pointermove', 40, 10)
    press(title, new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 10 }))

    expect(field(), 'a drag opened the title field').toBeNull()
    expect(opened).toBe(0)
  })

  it('opens the field for a press that stayed under the threshold', () => {
    mount(row('a', 'Write the report'))
    const title = titleTrigger()

    pointer(title, 'pointerdown', 10, 10)
    pointer(title, 'pointermove', 12, 11)
    press(title, new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 11 }))

    expect(field(), 'a tap under the threshold opened nothing').not.toBeNull()
  })

  it('takes the row off the drag while its title is being edited', () => {
    mount(row('a', 'Write the report'))
    expect(view!.container.querySelector('article')!.draggable, 'the row starts out draggable').toBe(true)

    press(titleTrigger())

    expect(view!.container.querySelector('article')!.draggable, 'an open field left the row draggable').toBe(false)
  })

  it('gives the row its drag back once the title is written', async () => {
    mount(row('a', 'Write the report'))
    press(titleTrigger())
    typeField('Renamed')
    key(field()!, 'Enter')
    await settle()

    expect(view!.container.querySelector('article')!.draggable).toBe(true)
  })
})
