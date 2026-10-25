/**
 * The keys the to-do app answers, and the one table that says what they do.
 *
 * The container used to hold a `keydown` handler of five keys inside itself. That shape has two
 * problems this file fixes: the effect had no dependency list, so every render attached a second
 * listener and left the previous one behind (defect A18), and a key list living inside a handler can
 * only ever be printed by copying it — which is exactly how a shortcut reference starts lying. So the
 * bindings live here as data (`TODO_SHORTCUT_ROWS`, read by the `?` panel) and as one map from a
 * keystroke to the id that names it (`SINGLE_KEYS`), and the listener is attached once. The handler
 * itself is handed to the effect through a ref, the same way `useEscape` carries its callback, so the
 * closure always reads the frame's current state without the document ever being re-bound.
 *
 * Four doors decide whether a key is the app's to answer at all, and the order is the whole design: a
 * keystroke somebody else already took, a key an input method is still assembling, a field the reader
 * is typing into, and a panel that owns the screen all stand before any binding is consulted. `d`
 * inside a task's title box is the letter d, not "finish this task" — the case the plan calls the one
 * most likely to be missed, and the reason the guards come first rather than per binding.
 *
 * The task-level keys act on the row the caret stands on, and the caret model is the one the cards
 * already ship: `[data-todo-open]` is a row's own title control and carries its task's id. Nothing
 * here invents a second one. A row-scoped key pressed with nothing focused moves the caret to the
 * first row rather than swallowing the press, because a key that silently does nothing is the defect
 * this surface exists to remove.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { t } from '../../lib/i18n'
import { isEditableTarget } from '../../lib/hotkeys'
import { isImeComposing } from '../../lib/ime'
import { prompt, type MenuItem } from '../../components/overlay'
import type { MessageKey } from '@shared/locales/en-US'
import type { TodoTask } from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import { useTodos } from './store'
import { useFocusSession } from './focus-session'
import { moveTodoTask, openTaskSiblings, useTaskMoves } from './TaskCard'
import { buildScheduleMenuItems, buildTaskContextMenuItems, type TaskMenuHandlers } from './task-menu'

/** Every keystroke this hook answers. The `?` panel prints one row per member of this list. */
export type TodoShortcutId =
  | 'new-task'
  | 'search'
  | 'toggle-sidebar'
  | 'row-down'
  | 'row-up'
  | 'escape'
  | 'help'
  | 'complete'
  | 'details'
  | 'start-pause'
  | 'focus'
  | 'add-step'
  | 'task-menu'
  | 'schedule'
  | 'clear-schedule'
  | 'swap-up'
  | 'swap-down'
  | 'to-top'
  | 'to-bottom'

/**
 * `edit-title` is in the table but not in the union above, and that gap is the point.
 *
 * Enter on a row is answered by the row's own title control, not by anything here: a browser activates
 * a focused `<button>` on Enter, and the card answers that by opening the title box on the spot. A
 * container that listened for Enter too would either rename the task twice or cancel the row. The task
 * itself keeps its own way in — the `i` key, and a press anywhere on the row that is not its title. The
 * key is listed here because the panel is the reader's only map of what this surface answers to.
 */
export type TodoShortcutRowId = TodoShortcutId | 'edit-title'

/** The headings the table files its rows under, in the order a reader learns them. */
export type TodoShortcutGroup = 'browse' | 'task' | 'schedule' | 'order'

/** One line of the `?` panel: the caps to draw, and the words that say what the key does. */
export interface TodoShortcutRow {
  id: TodoShortcutRowId
  /** Spelled as a reader presses it, so a `j` row reads `j` rather than `J`. */
  keys: readonly string[]
  group: TodoShortcutGroup
  label: MessageKey
}

export const TODO_SHORTCUT_GROUPS: readonly { id: TodoShortcutGroup; label: MessageKey }[] = [
  { id: 'browse', label: 'todo.keys.group.browse' },
  { id: 'task', label: 'todo.keys.group.task' },
  { id: 'schedule', label: 'todo.keys.group.schedule' },
  { id: 'order', label: 'todo.keys.group.order' },
]

/**
 * The first batch, and deliberately not a configurable map: the reference app carries around fifty
 * bindings because it owes its old users their old keys, and this surface owes nobody anything.
 *
 * `x` — "not doing this any more" — is the notable absence. It has nowhere to land until the cancelled
 * state R2-2 introduces exists, and a table row that answered nothing would be the one thing a
 * keyboard surface must not ship. It comes back with the state.
 */
export const TODO_SHORTCUT_ROWS: readonly TodoShortcutRow[] = [
  { id: 'new-task', keys: ['n'], group: 'browse', label: 'todo.action.new_task' },
  { id: 'search', keys: ['/'], group: 'browse', label: 'todo.action.search' },
  { id: 'toggle-sidebar', keys: ['['], group: 'browse', label: 'todo.action.toggle_sidebar' },
  { id: 'row-down', keys: ['j'], group: 'browse', label: 'todo.keys.action.next_row' },
  { id: 'row-up', keys: ['k'], group: 'browse', label: 'todo.keys.action.prev_row' },
  { id: 'help', keys: ['?'], group: 'browse', label: 'todo.keys.title' },
  { id: 'escape', keys: ['Esc'], group: 'browse', label: 'todo.keys.action.step_back' },
  { id: 'edit-title', keys: ['Enter'], group: 'task', label: 'todo.keys.action.edit_title' },
  { id: 'details', keys: ['i'], group: 'task', label: 'todo.keys.action.details' },
  { id: 'complete', keys: ['d'], group: 'task', label: 'todo.keys.action.complete' },
  { id: 'start-pause', keys: ['y'], group: 'task', label: 'todo.keys.action.start_pause' },
  { id: 'focus', keys: ['f'], group: 'task', label: 'todo.keys.action.focus' },
  { id: 'add-step', keys: ['a'], group: 'task', label: 'todo.task.step_add' },
  { id: 'task-menu', keys: ['q'], group: 'task', label: 'todo.keys.action.task_menu' },
  { id: 'schedule', keys: ['s'], group: 'schedule', label: 'todo.keys.action.schedule' },
  { id: 'clear-schedule', keys: ['u'], group: 'schedule', label: 'todo.date.clear' },
  { id: 'swap-up', keys: ['Ctrl', 'Shift', '↑'], group: 'order', label: 'todo.keys.action.swap_up' },
  { id: 'swap-down', keys: ['Ctrl', 'Shift', '↓'], group: 'order', label: 'todo.keys.action.swap_down' },
  { id: 'to-top', keys: ['Ctrl', 'Alt', '↑'], group: 'order', label: 'todo.keys.action.to_top' },
  { id: 'to-bottom', keys: ['Ctrl', 'Alt', '↓'], group: 'order', label: 'todo.keys.action.to_bottom' },
]

/** The single-key bindings, written as the characters a reader presses. */
const SINGLE_KEYS: ReadonlyMap<string, TodoShortcutId> = new Map<string, TodoShortcutId>([
  ['n', 'new-task'],
  ['/', 'search'],
  ['[', 'toggle-sidebar'],
  ['j', 'row-down'],
  ['k', 'row-up'],
  ['d', 'complete'],
  ['i', 'details'],
  ['y', 'start-pause'],
  ['f', 'focus'],
  ['a', 'add-step'],
  ['q', 'task-menu'],
  ['s', 'schedule'],
  ['u', 'clear-schedule'],
  ['?', 'help'],
  ['Escape', 'escape'],
])

/**
 * The keys that act on the row under the caret, and so need one to be pressed at all.
 *
 * These are the table's `task`, `schedule` and `order` groups, less `Enter`, which needs a row as well
 * but is answered by the row's own button rather than by anything here. The panel's copy names those
 * three groups as the row-scoped ones, and nothing enforces that the two lists stay in step — a fourth
 * row-scoped group belongs in both.
 */
const ROW_KEYS = new Set<TodoShortcutId>([
  'complete', 'details', 'start-pause', 'focus', 'add-step', 'task-menu', 'schedule', 'clear-schedule',
  'swap-up', 'swap-down', 'to-top', 'to-bottom',
])

/**
 * How wide the panel a key opens is. The number belongs to the row's menu, not to the key that opens
 * it, so it is named once in `task-menu.ts` and passed through here for the frame that renders it.
 */
export { TASK_ROW_MENU_WIDTH as TODO_ROW_MENU_WIDTH } from './task-menu'

/** What the container hands the hook: the state that lives in the frame rather than in the store. */
export interface TodoShortcutHost {
  /** The board every view sits in; `j`/`k` walk its `[data-todo-open]` rows in reading order. */
  contentRef: RefObject<HTMLElement | null>
  /** The header's search field, which a wide window keeps on screen and a phone has to open first. */
  searchRef: RefObject<HTMLInputElement | null>
  wide: boolean
  /** Whether the phone's full-width search is the thing standing in front of the title. */
  searchOpen: boolean
  page: 'main' | 'lists'
  openSearch: () => void
  closeSearch: () => void
  toggleSidebar: () => void
  newTask: () => void
  goMain: () => void
}

/** The panel a key opened: where it opens, what it offers, and what the surface is called. */
export interface TodoShortcutMenu {
  point: { x: number; y: number }
  items: MenuItem[]
  label: string
}

export interface TodoShortcuts {
  /** The menu `q` or `s` opened, or null while no key has asked for one. */
  menu: TodoShortcutMenu | null
  closeMenu: () => void
  helpOpen: boolean
  closeHelp: () => void
}

/**
 * Whether a panel owns the screen.
 *
 * The same reading the app's global hotkey registry uses (`lib/hotkeys.ts`), so a key that is dead
 * behind a dialog is dead here too. Two answers to that question is how a binding ends up firing into
 * a panel the reader never meant to leave.
 */
function overlayIsOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="menu"]'))
}

/** The keystroke this hook answers, or null for one it leaves to the browser and to the shell. */
function resolveShortcut(event: KeyboardEvent): TodoShortcutId | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!direction) return null
    // Both chords are Control's: a Meta or a lone-Alt arrow belongs to the shell, the editor or the
    // window manager, and taking it would break a keystroke this surface has no claim on. Neither
    // chord carries the other's modifier — a Ctrl+Alt+Shift arrow is nobody's, and claiming it would
    // be one more key taken for nothing.
    if (event.metaKey || !event.ctrlKey) return null
    if (event.altKey) return event.shiftKey ? null : (direction < 0 ? 'to-top' : 'to-bottom')
    return event.shiftKey ? (direction < 0 ? 'swap-up' : 'swap-down') : null
  }
  // A shifted letter arrives as a different `key` (`N`), so it is simply not in the table. `?` is the
  // case that proves the reading right: it is only ever reachable with Shift held.
  return SINGLE_KEYS.get(event.key) ?? null
}

/** The row the caret stands on, found by the id its own body carries. */
function focusedRow(): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return null
  const body = active.closest<HTMLElement>('[data-todo-open]')
  if (body) return body
  // The checkbox and the kebab sit beside the title body rather than inside it, and a reader standing
  // on either is standing on that row: `<article>` is one card, and one card is one row.
  return active.closest('article')?.querySelector<HTMLElement>('[data-todo-open]') ?? null
}

export function useTodoShortcuts(host: TodoShortcutHost): TodoShortcuts {
  const [menu, setMenu] = useState<TodoShortcutMenu | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  /**
   * The card's own move arithmetic, asked for once.
   *
   * Up and down are not reimplemented here: `useTaskMoves` is what decides which rows count as
   * neighbours and what anchors a move before the row *after* the neighbour, and a second copy of that
   * would be a second answer to a question the listing has already settled.
   */
  const movesForTask = useTaskMoves(true)

  /** The rows this page holds, in the order the page drew them. */
  function rowNodes(): HTMLElement[] {
    return [...(host.contentRef.current?.querySelectorAll<HTMLElement>('[data-todo-open]') ?? [])]
  }

  /**
   * Open the row's panel: the schedule strip for `s`, the right-click's whole list for `q`.
   *
   * Both come from `task-menu.ts`, which is what the kebab and a right-click already answer with, so a
   * key is a third way to reach the same rows rather than a fourth copy of them. The panel opens at the
   * row's own box, which is where a reader is looking when they press the key.
   */
  function openRowMenu(kind: 'task-menu' | 'schedule', row: HTMLElement, task: TodoTask): void {
    const state = useTodos.getState()
    const box = row.getBoundingClientRect()
    const handlers: TaskMenuHandlers = {
      timezone: state.timezone,
      now: Date.now(),
      lists: state.lists,
      move: movesForTask(task) ?? undefined,
      update: (patch) => { void useTodos.getState().updateTask(task.id, patch) },
      // The same rule the card draws: a finished row has nothing left to be reminded about.
      snooze: isTaskDone(task.status)
        ? undefined
        : (minutes) => { void useTodos.getState().snoozeTask(task.id, minutes) },
      onClose: () => setMenu(null),
    }
    setMenu({
      point: { x: box.left, y: box.bottom + 1 },
      items: kind === 'schedule' ? buildScheduleMenuItems(task, handlers) : buildTaskContextMenuItems(task, handlers),
      label: t('todo.task.actions'),
    })
  }

  /** Walk the caret between rows, in the order the page draws them. */
  function moveCaret(event: KeyboardEvent, step: number): void {
    const nodes = rowNodes()
    if (!nodes.length) return
    event.preventDefault()
    const index = nodes.findIndex((node) => node === document.activeElement)
    // With the caret outside the rows — a header button, or nowhere — `j` starts at the first one and
    // `k` at the last, so neither key can strand a reader who has lost the caret.
    if (index === -1) {
      nodes[step > 0 ? 0 : nodes.length - 1]?.focus()
      return
    }
    nodes[Math.min(nodes.length - 1, Math.max(0, index + step))]?.focus()
  }

  /**
   * Finish a row, and stand the caret on its neighbour first.
   *
   * A finished row leaves the listing the moment the write lands, and a caret that sat on it goes to
   * the document with it: the next `j` would start again from the top of the page. The neighbour is
   * named before the write, so a run of `d` walks down the list rather than back to its head.
   */
  function completeRow(event: KeyboardEvent, row: HTMLElement, task: TodoTask): void {
    const nodes = rowNodes()
    const index = nodes.indexOf(row)
    const carry = nodes[index + 1] ?? nodes[Math.max(0, index - 1)]
    carry?.focus()
    void useTodos.getState().toggleTask(task)
    event.preventDefault()
  }

  /**
   * Escape, one rung at a time — and only the rungs this frame owns.
   *
   * A panel above the frame answers Escape before it reaches here and stops the keystroke with it,
   * which is why the rungs below start at the selection rather than at the screen. Selection is a
   * mode, so leaving it comes before leaving a search or a page: the reader is looking at the bar.
   */
  function stepBack(): void {
    const state = useTodos.getState()
    if (state.selectedIds.size > 0) {
      state.clearSelection()
      return
    }
    if (host.searchOpen) {
      host.closeSearch()
      return
    }
    if (host.page === 'lists') host.goMain()
  }

  /** The handler, rebuilt every render so it closes over the frame's current state. */
  const handlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  handlerRef.current = (event: KeyboardEvent): void => {
    // A key another surface answered, and a key an input method is still assembling, are not ours.
    if (event.defaultPrevented || isImeComposing(event)) return
    // A field owns every key you can type into it, and a panel owns the screen it is on. Both before
    // the bindings, because a guard that has to be remembered per key is a guard that gets missed.
    if (isEditableTarget(event.target) || overlayIsOpen()) return

    const id = resolveShortcut(event)
    if (!id) return
    // Holding a key down is one gesture, not a queue of writes; only the caret's own walk may repeat.
    if (event.repeat && id !== 'row-down' && id !== 'row-up') return

    if (id === 'escape') {
      stepBack()
      return
    }
    if (id === 'help') {
      event.preventDefault()
      setHelpOpen(true)
      return
    }
    if (id === 'new-task') {
      event.preventDefault()
      host.newTask()
      return
    }
    if (id === 'search') {
      event.preventDefault()
      if (host.wide) host.searchRef.current?.focus()
      else host.openSearch()
      return
    }
    if (id === 'toggle-sidebar') {
      event.preventDefault()
      host.toggleSidebar()
      return
    }
    if (id === 'row-down' || id === 'row-up') {
      moveCaret(event, id === 'row-down' ? 1 : -1)
      return
    }

    // Everything below is a row-scoped key. While rows are picked the bar acts on the group, and a
    // card hides every single-row write it owns, so a container key would be doing the one thing the
    // card refused to do.
    if (ROW_KEYS.has(id) && useTodos.getState().selectedIds.size > 0) return

    const row = focusedRow()
    if (!row) {
      // Nothing under the caret. Rather than swallow the press, put the caret where the key would have
      // worked, so the reader can see the row the next press will act on.
      const first = rowNodes()[0] ?? null
      if (!first) return
      event.preventDefault()
      first.focus()
      return
    }
    const rowId = row.dataset.todoOpen
    const state = useTodos.getState()
    const task = state.tasks.find((entry) => entry.id === rowId) ?? state.completed.find((entry) => entry.id === rowId)
    if (!task) return

    switch (id) {
      case 'complete':
        completeRow(event, row, task)
        return
      case 'details':
        event.preventDefault()
        void state.openTask(task.id)
        return
      case 'start-pause': {
        // The rows the card's own menu offers, and no further: a finished task has nothing left to
        // start, and a key that pretended otherwise would be a button that lies.
        if (isTaskDone(task.status)) return
        event.preventDefault()
        void state.updateTask(task.id, { status: task.status === 'in_progress' ? 'todo' : 'in_progress' })
        return
      }
      case 'focus': {
        // The panel opens on the row and starts nothing: the interval begins at the reader's own press,
        // which is also the gesture the audio cues have to be unlocked by (D9). A finished row has no
        // block left to work, so the key is not offered for one — the same rule the card draws.
        if (isTaskDone(task.status)) return
        event.preventDefault()
        useFocusSession.getState().open(task.id)
        return
      }
      case 'add-step': {
        event.preventDefault()
        // The app's own prompt, so the answer is a field with a caret in it rather than a native dialog
        // a reader cannot leave with Tab. A cancelled or empty answer files nothing.
        void prompt({ title: t('todo.task.step_add'), placeholder: t('todo.task.step_add') }).then((text) => {
          const step = text?.trim()
          if (step) void useTodos.getState().addStep(task.id, step)
        })
        return
      }
      case 'task-menu':
      case 'schedule':
        openRowMenu(id, row, task)
        event.preventDefault()
        return
      case 'clear-schedule':
        // The strip's own "clear date" row, and the same rule in front of it: a row with no date has
        // nothing to take off.
        if (task.dueAt === null) return
        event.preventDefault()
        void state.updateTask(task.id, { dueAt: null })
        return
      case 'swap-up':
      case 'swap-down': {
        const move = movesForTask(task)
        const order = move?.order
        if (!order) return
        if (id === 'swap-up' ? !order.up : !order.down) return
        event.preventDefault()
        if (id === 'swap-up') order.moveUp()
        else order.moveDown()
        return
      }
      case 'to-top': {
        const head = openTaskSiblings(state.tasks, task)[0]
        if (!head || head.id === task.id) return
        event.preventDefault()
        void moveTodoTask(task.id, { beforeId: head.id })
        return
      }
      case 'to-bottom': {
        const siblings = openTaskSiblings(state.tasks, task)
        const last = siblings[siblings.length - 1]
        if (!last || last.id === task.id) return
        event.preventDefault()
        // No anchor is an append — the same placement a card dragged to the bottom of its list asks for.
        void moveTodoTask(task.id, { beforeId: null })
        return
      }
      default:
        // Every id `resolveShortcut` answers has a door above, so nothing reaches here. The default
        // exists to keep that claim checked: a new id with no handler fails the union, not the reader.
        return
    }
  }

  // One listener for the life of the frame. The handler it calls is the current render's, handed over
  // through a ref — the pattern `useEscape` uses — so the bindings read fresh state without the effect
  // ever re-attaching, which is what left a stack of listeners behind before.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { handlerRef.current(event) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return {
    menu,
    closeMenu: () => setMenu(null),
    helpOpen,
    closeHelp: () => setHelpOpen(false),
  }
}
