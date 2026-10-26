// @vitest-environment jsdom
/**
 * The to-do app's keyboard layer.
 *
 * Three things are pinned here, in the order they are easy to get wrong.
 *
 * The first is the one the plan called out: a bare key must mean the key, not the command, while the
 * reader is typing. So the guards are tested against each door separately — a text field, a menu, a
 * dialog — because a case that only proves one of them lets the other two regress, and the field the
 * plan names is the task's own title box.
 *
 * The second is that one listener answers the page. The handler this replaces sat in the container
 * inside an effect with no dependency list, so every render added another `keydown` listener and left
 * the previous one attached; a press then ran the action once per render. The case that pins the fix
 * renders the frame a few times before it presses anything.
 *
 * The third is that a key which opens a panel opens *the* panel. `q` and `s` reach the rows
 * `task-menu.ts` builds for the kebab and the right-click, so the assertions name those rows rather
 * than a copy of them, and the `?` panel prints the table the handler binds from rather than a list
 * somebody kept up to date by hand.
 */
import { act, createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { Menu, PromptHost } from '../../components/overlay'
import { localDate } from '@shared/assistant-time'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

/** What the fake server holds, and every write the keys actually made. */
const server = vi.hoisted(() => ({
  rows: [] as TodoTask[],
  timezone: 'UTC',
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  moves: [] as { id: string; body: { beforeId: string | null; listId?: string | null } }[],
  steps: [] as { id: string; text: string }[],
}))

vi.mock('../../lib/api', async () => {
  // The route reads a bare day the same way (`routes/todos.ts`'s `parseDue`), so a strip row answers
  // with that day's end in the account zone rather than with something this file invented.
  const { parseLocalTime } = await import('@shared/assistant-time')
  const counts: TaskCounts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
    completed: 0, starred: 0, byList: {}, byTag: {},
  }
  const readDueAt = (value: unknown, current: number | null): number | null => {
    if (value === undefined) return current
    if (value === null || value === '') return null
    if (typeof value === 'number') return value
    return parseLocalTime(String(value), server.timezone)
  }
  const read = (id: string): TodoTask => server.rows.find((entry) => entry.id === id)!
  return {
    api: {
      todos: {
        list: async () => ({
          tasks: server.rows,
          total: server.rows.length,
          counts: { ...counts, all: server.rows.length },
          dayEnd: Date.now() + 3_600_000,
          timezone: server.timezone,
        }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        get: async (id: string) => ({ task: server.rows.find((entry) => entry.id === id) ?? null, steps: [] }),
        update: async (id: string, patch: Record<string, unknown>) => {
          server.updates.push({ id, patch })
          const index = server.rows.findIndex((entry) => entry.id === id)
          const before = read(id)
          const task = {
            ...before,
            ...patch,
            dueAt: readDueAt(patch.dueAt, before.dueAt),
            updatedAt: Date.now(),
          } as TodoTask
          if (index >= 0) server.rows[index] = task
          return { task, next: null }
        },
        move: async (id: string, body: { beforeId: string | null; listId?: string | null }) => {
          server.moves.push({ id, body })
          // The reorder the route answers with: the row lands where its anchor names it, and no anchor
          // is the tail.
          const index = server.rows.findIndex((entry) => entry.id === id)
          if (index >= 0) {
            const [moved] = server.rows.splice(index, 1)
            const anchor = body.beforeId === null
              ? server.rows.length
              : server.rows.findIndex((entry) => entry.id === body.beforeId)
            server.rows.splice(anchor < 0 ? server.rows.length : anchor, 0, moved!)
          }
          return { task: read(id) }
        },
        addStep: async (id: string, text: string) => {
          server.steps.push({ id, text })
          return { step: { id: 'step-1', taskId: id, text, done: false, position: 0, createdAt: Date.now() } }
        },
      },
    },
  }
})

import { useTodos } from './store'
import { TodosApp } from './TodosApp'
import { TODO_ROW_MENU_WIDTH, useTodoShortcuts } from './use-todo-shortcuts'
import { TodoKeysHelp } from './TodoKeysHelp'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
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
    listId: 'work',
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

const ROW_IDS = ['a', 'b', 'c']
const original = useTodos.getState()
let view: RenderedElement | null = null

/** The frame's own state, which the hook is handed rather than read from the store. */
let host: Record<'openSearch' | 'closeSearch' | 'toggleSidebar' | 'newTask' | 'goMain', Mock<() => void>>

beforeEach(async () => {
  localStorage.clear()
  // The address is part of the frame's state: a case that opened a task left `?task=` behind, and the
  // container reads it before it draws anything, so the next case would mount with a dialog open.
  window.history.replaceState({}, '', '/todo')
  await initI18n()
  server.rows = []
  server.timezone = 'UTC'
  server.updates.length = 0
  server.moves.length = 0
  server.steps.length = 0
  useTodos.setState(original, true)
  frameProps = {}
  host = {
    openSearch: vi.fn(() => {}),
    closeSearch: vi.fn(() => {}),
    toggleSidebar: vi.fn(() => {}),
    newTask: vi.fn(() => {}),
    goMain: vi.fn(() => {}),
  }
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

interface FrameProps {
  wide?: boolean
  searchOpen?: boolean
  page?: 'main' | 'lists'
}

/**
 * The frame's own state, read by the harness rather than passed to it.
 *
 * A real container re-renders when its state changes — closing the phone's search is a `set`, not a
 * prop somebody remembers to hand over again. Reading one object the test mutates before it re-renders
 * keeps that shape, which is what makes the Escape rungs mean anything.
 */
let frameProps: FrameProps = {}

/**
 * The container, reduced to what the keyboard layer actually touches.
 *
 * A row is a card's real shape — an `article` with a sibling checkbox beside the body that carries the
 * task's id — because that is the contract `j`/`k` and every row-scoped key reads, and a harness that
 * drew rows some other way would be testing a shape the app does not have. `PromptHost` is mounted
 * beside it because `a` asks a question through the app's own dialog, and a host that is not there
 * answers `false` and proves nothing.
 */
function Harness(props: FrameProps = {}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const shortcuts = useTodoShortcuts({
    contentRef,
    searchRef,
    wide: props.wide ?? frameProps.wide ?? true,
    searchOpen: props.searchOpen ?? frameProps.searchOpen ?? false,
    page: props.page ?? frameProps.page ?? 'main',
    openSearch: host.openSearch,
    closeSearch: host.closeSearch,
    toggleSidebar: host.toggleSidebar,
    newTask: host.newTask,
    goMain: host.goMain,
  })
  return createElement('div', {}, [
    createElement('div', { key: 'rows', ref: contentRef }, ROW_IDS.map((id) => createElement('article', { key: id }, [
      createElement('button', { key: 'box', type: 'button', 'aria-label': `tick ${id}` }),
      createElement('button', { key: 'body', type: 'button', 'data-todo-open': id }, id),
    ]))),
    createElement('input', { key: 'search', ref: searchRef, 'aria-label': 'the search field' }),
    createElement('input', { key: 'title', 'aria-label': 'the title field' }),
    shortcuts.menu && createElement(Menu, {
      key: 'menu',
      anchor: shortcuts.menu.point,
      open: true,
      onClose: shortcuts.closeMenu,
      items: shortcuts.menu.items,
      width: TODO_ROW_MENU_WIDTH,
      label: shortcuts.menu.label,
    }),
    createElement(TodoKeysHelp, { key: 'help', open: shortcuts.helpOpen, onClose: shortcuts.closeHelp }),
  ])
}

/** Put three rows on the page and mount the frame that answers keys for them. */
function mount(props: FrameProps = {}, rows: TodoTask[] = ROW_IDS.map((id) => task(id))): void {
  server.rows = rows
  frameProps = props
  useTodos.setState({
    status: 'ready',
    tasks: rows,
    total: rows.length,
    fetched: rows.length,
    completed: [],
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set<string>(),
  })
  view = renderElement(createElement('div', {}, [
    createElement(Harness, { key: 'frame' }),
    createElement(PromptHost, { key: 'prompt-host' }),
  ]))
}

/** Change the frame's state the way a `set` would: mutate it, then let the page draw the answer. */
function setFrame(props: FrameProps): void {
  frameProps = { ...frameProps, ...props }
  view!.rerender(createElement('div', {}, [
    createElement(Harness, { key: 'frame' }),
    createElement(PromptHost, { key: 'prompt-host' }),
  ]))
}

/** One row's body, which is what carries the id and takes the caret. */
function row(id: string): HTMLButtonElement | null {
  return view!.container.querySelector<HTMLButtonElement>(`[data-todo-open="${id}"]`)
}

function field(label: string): HTMLInputElement | null {
  return view!.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
}

/**
 * A keystroke, sent from wherever the caret stands.
 *
 * `bubbles` and `cancelable` are what make the answer mean anything: a hand-made event that cannot be
 * cancelled says nothing about whether the app took the key. The return is `defaultPrevented` — the
 * app's own way of saying "this one was mine".
 */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event.defaultPrevented
}

function focusRow(id: string): void {
  act(() => { row(id)!.focus() })
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]')
}

function menuLabels(): string[] {
  return [...(menu()?.querySelectorAll<HTMLElement>('button[role="menuitem"], button[role="menuitemcheckbox"]') ?? [])]
    .map((node) => (node.textContent ?? '').trim())
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

/** A panel that is on the screen but was not opened by a key: the guard reads what is mounted. */
function mountBarePanel(role: 'menu' | 'dialog'): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('role', role)
  document.body.appendChild(panel)
  return panel
}

/**
 * Let the write, the reload behind it and the prompt's own answer run to completion.
 *
 * The reload is a chain of awaits inside the store, so microtasks alone can leave its `set` landing in
 * the next case — React then reports an update outside `act`, which is noise that hides the real one.
 * A macrotask tick closes the chain.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function lastPatch(): Record<string, unknown> {
  const last = server.updates[server.updates.length - 1]
  return last ? last.patch : {}
}

function lastMove(): { id: string; body: { beforeId: string | null; listId?: string | null } } | undefined {
  return server.moves[server.moves.length - 1]
}

/** Type into a controlled field the way a reader does: the value, then the event React listens for. */
function typeInto(node: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the keys that must stay letters', () => {
  it('leaves a d typed into the title field a letter', () => {
    mount()
    focusRow('a')
    act(() => { field('the title field')!.focus() })

    expect(press('d'), 'the field kept the caret but the app took the key').toBe(false)
    expect(server.updates, 'a task was completed from inside the title box').toEqual([])
  })

  it('leaves every key to an open menu', () => {
    mount()
    focusRow('a')
    const panel = mountBarePanel('menu')

    for (const key of ['d', 'i', 's', 'q', 'j', '?', 'n']) {
      expect(press(key), `${key} fired behind a menu`).toBe(false)
    }
    expect(host.newTask).not.toHaveBeenCalled()
    expect(server.updates).toEqual([])
    expect(document.activeElement, 'the caret moved while a menu had the screen').toBe(row('a'))
    panel.remove()
  })

  it('leaves every key to an open dialog', () => {
    mount()
    focusRow('a')
    const panel = mountBarePanel('dialog')

    expect(press('d')).toBe(false)
    expect(press('Escape'), 'Escape was taken from under the dialog').toBe(false)
    expect(server.updates).toEqual([])
    panel.remove()
  })

  it('leaves a keystroke to an input method still assembling it', () => {
    mount()
    focusRow('a')

    expect(press('d', { isComposing: true })).toBe(false)
    expect(press('Escape', { isComposing: true })).toBe(false)
    expect(server.updates).toEqual([])
    expect(host.closeSearch).not.toHaveBeenCalled()
  })

  it('treats a key held down as one gesture, not a queue of writes', () => {
    mount()
    focusRow('a')

    expect(press('d', { repeat: true })).toBe(false)
    expect(server.updates).toEqual([])
    // The caret's own walk is the exception: running a list down with `j` is one motion.
    press('j', { repeat: true })
    expect(document.activeElement).toBe(row('b'))
  })

  it('binds nothing to x until a cancelled task has somewhere to go', () => {
    mount()
    focusRow('a')

    expect(press('x'), 'a key with no state behind it answered anyway').toBe(false)
    expect(server.updates).toEqual([])
  })
})

describe('the frame’s own keys', () => {
  it('asks the container for a new task, a wider board and a search', () => {
    mount()

    expect(press('n')).toBe(true)
    expect(host.newTask).toHaveBeenCalledTimes(1)
    // `[` before `/`, because `/` puts the caret in a field and every key after it belongs to that field.
    expect(press('[')).toBe(true)
    expect(host.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(press('/')).toBe(true)
    expect(document.activeElement).toBe(field('the search field'))
  })

  it('opens the phone’s search instead of focusing a field that is not on screen', () => {
    mount({ wide: false })

    expect(press('/')).toBe(true)
    expect(host.openSearch).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(field('the search field'))
  })

  it('attaches one listener no matter how many times the frame rendered', () => {
    mount()
    // The handler this replaces lived in an effect with no dependency list, so three renders meant
    // four listeners, and four new tasks out of one press.
    for (let index = 0; index < 3; index += 1) view!.rerender(createElement(Harness))

    expect(press('n')).toBe(true)
    expect(host.newTask).toHaveBeenCalledTimes(1)
    expect(press('[')).toBe(true)
    expect(host.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('walks the caret down and up the rows the page drew', () => {
    mount()

    expect(press('j')).toBe(true)
    expect(document.activeElement).toBe(row('a'))
    press('j')
    expect(document.activeElement).toBe(row('b'))
    press('j')
    expect(document.activeElement).toBe(row('c'))
    // The ends are walls, not wraps: `j` at the bottom stays at the bottom.
    press('j')
    expect(document.activeElement).toBe(row('c'))
    press('k')
    expect(document.activeElement).toBe(row('b'))
    // With the caret outside the rows, `k` starts from the last one and `j` from the first, so neither
    // key can strand a reader who has lost the caret.
    act(() => { row('b')!.blur() })
    press('k')
    expect(document.activeElement).toBe(row('c'))
    act(() => { row('c')!.blur() })
    press('j')
    expect(document.activeElement).toBe(row('a'))
  })

  it('takes the caret off a sibling button onto the row it belongs to', async () => {
    mount()
    const box = view!.container.querySelector<HTMLButtonElement>('button[aria-label="tick b"]')
    act(() => { box!.focus() })

    expect(press('d')).toBe(true)
    await settle()
    expect(server.updates).toEqual([{ id: 'b', patch: { status: 'done' } }])
  })

  it('steps back out of the level the reader is standing on', () => {
    mount({ searchOpen: true, page: 'lists' })
    useTodos.setState({ selectedIds: new Set(['a']) })

    press('Escape')
    expect(useTodos.getState().selectedIds.size).toBe(0)
    // Out of the mode, the phone's full-width search is the next thing to give back — and the frame
    // closes it, so the press after that is already standing one level further out.
    press('Escape')
    expect(host.closeSearch).toHaveBeenCalledTimes(1)
    expect(host.goMain).not.toHaveBeenCalled()
    setFrame({ searchOpen: false })
    press('Escape')
    expect(host.goMain).toHaveBeenCalledTimes(1)
  })
})

describe('a key pressed on the row under the caret', () => {
  it('finishes it, and stands the caret on the next row', async () => {
    mount()
    focusRow('a')

    expect(press('d')).toBe(true)
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { status: 'done' } }])
    // A finished row leaves the listing when the write lands, and a caret left on it goes with it.
    expect(document.activeElement).toBe(row('b'))
  })

  it('steps back to the previous row when it finishes the last one', async () => {
    mount()
    focusRow('c')

    press('d')
    await settle()

    expect(server.updates).toEqual([{ id: 'c', patch: { status: 'done' } }])
    expect(document.activeElement).toBe(row('b'))
  })

  it('opens the task the caret stands on for i', async () => {
    mount()
    focusRow('a')

    expect(press('i')).toBe(true)
    await settle()
    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().selectedId).toBe('a')
  })

  it('starts a row that has not started, and pauses one that has', async () => {
    mount()
    focusRow('a')

    expect(press('y')).toBe(true)
    await settle()
    expect(lastPatch()).toEqual({ status: 'in_progress' })

    // The same key, the other way round: the row is now the one that is running.
    focusRow('a')
    press('y')
    await settle()
    expect(lastPatch()).toEqual({ status: 'todo' })
  })

  it('refuses to start a finished row, the way its menu refuses the row', async () => {
    mount({}, [task('a', { status: 'done' })])
    focusRow('a')

    expect(press('y'), 'it started a row with nothing left to start').toBe(false)
    expect(server.updates).toEqual([])
  })

  it('clears the day off a row that has one, and leaves a row that has none alone', async () => {
    mount({}, [task('a', { dueAt: NOW }), task('b')])
    focusRow('a')

    expect(press('u')).toBe(true)
    await settle()
    expect(lastPatch()).toEqual({ dueAt: null })

    focusRow('b')
    expect(press('u'), 'it cleared a date that was never there').toBe(false)
    expect(server.updates).toHaveLength(1)
  })

  it('takes the caret to the first row when a task key is pressed on nothing', () => {
    mount()

    expect(press('d')).toBe(true)
    expect(document.activeElement).toBe(row('a'))
    expect(server.updates).toEqual([])
  })

  it('stands down while rows are picked, because the bar acts on the group', () => {
    mount()
    focusRow('a')
    useTodos.setState({ selectedIds: new Set(['b', 'c']) })

    for (const key of ['d', 'i', 'y', 'u', 's', 'q', 'a']) {
      expect(press(key), `${key} acted on one row of a group`).toBe(false)
    }
    expect(server.updates).toEqual([])
    // The caret is not a write, so it keeps walking.
    expect(press('j')).toBe(true)
  })

  it('asks for a step through the app’s own dialog, never a native one', async () => {
    const nativePrompt = vi.spyOn(window, 'prompt').mockReturnValue('typed into the browser')
    mount()
    focusRow('a')

    expect(press('a')).toBe(true)
    const panel = dialog()
    expect(panel, 'the key opened no dialog').not.toBeNull()
    expect(panel!.textContent).toContain(t('todo.task.step_add'))
    expect(nativePrompt, 'the key raised a browser prompt').not.toHaveBeenCalled()

    typeInto(panel!.querySelector<HTMLInputElement>('input')!, 'post the letter')
    const accept = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === t('overlay.confirm'))!
    act(() => { accept.click() })
    await settle()

    expect(server.steps).toEqual([{ id: 'a', text: 'post the letter' }])
    nativePrompt.mockRestore()
  })

  it('leaves the step it was asked for out when the answer is empty', async () => {
    mount()
    focusRow('a')

    press('a')
    const accept = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === t('overlay.confirm'))!
    // The dialog keeps its own promise: nothing to file, so the row is not even pressed.
    expect(accept.disabled, 'the dialog let an empty step be filed').toBe(true)
    expect(server.steps).toEqual([])
  })

  it('swaps a row with its neighbour and sends one to either end of the order', async () => {
    mount()
    focusRow('b')

    expect(press('ArrowUp', { ctrlKey: true, shiftKey: true })).toBe(true)
    await settle()
    expect(lastMove()).toEqual({ id: 'b', body: { beforeId: 'a' } })

    focusRow('b')
    press('ArrowDown', { ctrlKey: true, shiftKey: true })
    await settle()
    // Down is an anchor two rows on: "before the row after my neighbour" is what a swap means, and it
    // is the card's own arithmetic rather than a second copy of it.
    expect(lastMove()!.body.beforeId).toBe('c')

    focusRow('b')
    press('ArrowDown', { ctrlKey: true, altKey: true })
    await settle()
    // No anchor is an append — the same placement a card dragged to the bottom of its list asks for.
    expect(lastMove()).toEqual({ id: 'b', body: { beforeId: null } })

    focusRow('b')
    press('ArrowUp', { ctrlKey: true, altKey: true })
    await settle()
    expect(lastMove()).toEqual({ id: 'b', body: { beforeId: 'a' } })
  })

  it('leaves a row that is already at an end where it is', () => {
    mount()
    focusRow('a')

    expect(press('ArrowUp', { ctrlKey: true, altKey: true }), 'it moved the first row up').toBe(false)
    expect(server.moves).toEqual([])
  })

  it('leaves the arrows alone when no modifier claims them', () => {
    mount()
    focusRow('a')

    expect(press('ArrowDown')).toBe(false)
    expect(press('ArrowDown', { ctrlKey: true })).toBe(false)
    expect(press('ArrowDown', { metaKey: true, shiftKey: true })).toBe(false)
    expect(press('ArrowDown', { ctrlKey: true, altKey: true, shiftKey: true })).toBe(false)
    expect(server.moves).toEqual([])
  })
})

describe('the panels a key opens', () => {
  it('opens the row’s schedule strip, and nothing beside it', () => {
    mount()
    focusRow('a')

    expect(press('s')).toBe(true)
    expect(menuLabels()).toEqual([
      t('todo.date.today'),
      t('todo.date.tomorrow'),
      t('todo.date.next_week'),
      t('todo.date.pick'),
    ])
    expect(menu()!.getAttribute('aria-label')).toBe(t('todo.task.actions'))
  })

  it('opens the menu a right-click opens, with the strip above the kebab’s rows', () => {
    mount()
    focusRow('a')

    expect(press('q')).toBe(true)
    const labels = menuLabels()
    expect(labels[0]).toBe(t('todo.date.today'))
    // The rows the kebab offers, from the function that builds both: a key is a third door onto them,
    // not a fourth list of them.
    expect(labels).toContain(t('todo.status.mark_in_progress'))
    expect(labels).toContain(t('todo.move.up'))
    expect(labels).toContain(t('todo.move.to_list'))
  })

  it('writes the day the strip picks, for the row that asked for it', async () => {
    mount()
    focusRow('a')

    press('s')
    act(() => { menu()!.querySelector<HTMLButtonElement>('button')!.click() })
    await settle()

    expect(menu(), 'the panel stayed up after its row').toBeNull()
    // The strip names a day and lets the server read it, so the patch is a bare date, not a midnight.
    expect(lastPatch()).toEqual({ dueAt: localDate(Date.now(), 'UTC') })
  })

  it('closes the panel it opened, and takes Escape with it', () => {
    mount()
    focusRow('a')

    press('q')
    expect(menu()).not.toBeNull()
    press('Escape')
    expect(menu(), 'Escape left the panel on the screen').toBeNull()
  })
})

describe('the ? panel', () => {
  it('prints the table the handler binds from', () => {
    mount()

    expect(press('?')).toBe(true)
    const panel = dialog()
    expect(panel, 'the key opened no panel').not.toBeNull()
    expect(panel!.textContent).toContain(t('todo.keys.title'))
    expect(panel!.textContent).toContain(t('todo.keys.subtitle'))

    // Caps, not a paragraph: a reader scans the letters they half-remember.
    const caps = [...(panel!.querySelectorAll<HTMLElement>('kbd'))].map((node) => (node.textContent ?? '').trim())
    expect(caps).toEqual(expect.arrayContaining([
      'n', '/', '[', 'j', 'k', '?', 'Esc', 'Enter', 'd', 'i', 'y', 'a', 'q', 's', 'u', '↑', '↓',
    ]))
    expect(panel!.textContent).toContain(t('todo.keys.action.complete'))
    expect(panel!.textContent).toContain(t('todo.task.step_add'))
    expect(panel!.textContent).toContain(t('todo.keys.group.order'))
    // The cancelled state has no key yet, and a row promising one would be a button that lies.
    expect(caps).not.toContain('x')
  })

  it('closes on Escape and hands the caret back to the row', () => {
    mount()
    focusRow('a')

    press('?')
    expect(dialog()).not.toBeNull()
    press('Escape')
    expect(dialog(), 'the panel outlived its Escape').toBeNull()
    expect(document.activeElement, 'the caret did not go back to the row').toBe(row('a'))
  })
})

describe('the container the keys are wired into', () => {
  /** The real frame: the panel a key opens and the field that must swallow a key have to be its own. */
  async function mountApp(rows: TodoTask[]): Promise<void> {
    stubBreakpoint(true)
    server.rows = rows
    useTodos.setState({
      status: 'ready',
      view: 'list',
      listId: 'work',
      tasks: rows,
      total: rows.length,
      fetched: rows.length,
      completed: [],
      lists: [{
        id: 'work', name: 'Work', icon: null, color: null, position: 0,
        createdAt: 0, updatedAt: 0, openCount: rows.length, doneCount: 0, archivedAt: null, parentId: null,
      }],
      tags: [],
      counts: {
        inbox: 0, today: 0, upcoming: 0, overdue: 0, all: rows.length,
        completed: 0, starred: 0, byList: { work: { open: rows.length, done: 0 } }, byTag: {},
      },
      timezone: 'UTC',
      dayEnd: NOW + DAY,
      selectedIds: new Set<string>(),
      editorOpen: false,
      draft: null,
    })
    view = renderElement(createElement(TodosApp))
    await settle()
    // The frame reads the address before it draws anything, and the address a previous case left behind
    // is not this case's screen. Asking the store for the list is how a reader would: it writes the
    // address it names, so the mount effect and the rows agree.
    act(() => { useTodos.getState().setView('list', { listId: 'work' }) })
    await settle()
  }

  it('opens its help panel from ?', async () => {
    await mountApp([task('a')])

    expect(press('?')).toBe(true)
    expect(dialog()?.textContent).toContain(t('todo.keys.title'))
    expect(dialog()?.querySelector('kbd'), 'the panel drew no key caps').not.toBeNull()
  })

  it('opens the editor from n, and leaves its title field alone', async () => {
    await mountApp([task('a')])

    expect(press('n')).toBe(true)
    expect(useTodos.getState().editorOpen).toBe(true)

    // The plan's regression, against the field it names: the editor's own title box, on the real frame.
    const title = document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.title_label')}"]`)
    expect(title, 'the editor opened without a title field').not.toBeNull()
    act(() => { title!.focus() })

    expect(press('d')).toBe(false)
    expect(press('i')).toBe(false)
    expect(server.updates).toEqual([])
  })

  it('opens a row’s schedule strip from s', async () => {
    await mountApp([task('a')])
    const body = view!.container.querySelector<HTMLButtonElement>('[data-todo-open="a"]')
    expect(body, 'the list drew no row').not.toBeNull()
    act(() => { body!.focus() })

    expect(press('s')).toBe(true)
    expect(menu()?.textContent).toContain(t('todo.date.today'))
  })
})
