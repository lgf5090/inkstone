/**
 * One task, as a card.
 *
 * The same component draws a board card, a row in the plan view and a line inside a list, because
 * those are the same object seen at three densities — a second implementation would drift the moment
 * one of them learned about steps or tags. The checkbox is a real `role="checkbox"` button with a
 * 44px hit area; the visible circle is 20px, which is what the reference app shows.
 *
 * A row carries two presses. The title is the one a reader aims at to change the name, so it opens a
 * box on the spot; everything else on the row is the way into the task itself. They are separate
 * controls rather than one button with a special corner, because one control that answers two
 * questions depending on where inside it the pointer landed is a control a keyboard cannot describe.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { CalendarMinus, Check, CircleDot, Hourglass, MoreHorizontal, Paperclip, Pause, Play, Star } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useDropState } from '../../lib/drop-state'
import { useMediaQuery } from '../../lib/hooks'
import { TagPill } from '../../components/TagChip'
import { Input } from '../../components/form'
import { Menu, useContextMenu } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useTodos } from './store'
import { EstimateDialog } from './estimate-picker'
import { buildTaskContextMenuItems, buildTaskMenuItems, TASK_ROW_MENU_WIDTH } from './task-menu'
import { attachFilesToTask } from './task-attachments'
import { BatchContextMenu } from './BatchBar'
import { dueLabel, priorityDot, priorityLabel } from './todo-ui'
import { taskColorOf } from './task-face'
import { ListIcon } from './list-icons'
import { formatTaskDuration } from '@shared/todos/duration'
import { isTaskDone, isTaskOpen } from '@shared/todos/status'
import type { SnoozeMinutes, TaskList, TodoTask } from '@shared/todos/model'

/** How long a finger has to stay down before the row joins a selection instead of opening. */
const LONG_PRESS_MS = 500

/**
 * The whole of the consumption bar, as the share a reader reads.
 *
 * A percentage rather than a fraction because the value is handed to the layout as the width of a
 * strip: `100` is "the plan is spent", and a running row past its plan is clamped to it rather than
 * being allowed to overflow the row it belongs to.
 */
const ESTIMATE_BAR_FULL = 100

/**
 * How far a press on the title may travel before it is the drag the row is draggable for.
 *
 * Without it the two gestures are the same gesture: a browser reports a drag as a release, and a
 * pointer that moved 30px to reach the next row would otherwise leave a title box open on the way.
 * Five pixels is the width that reads as a slip rather than a shake of the finger, and the reference
 * app draws its line at the same place.
 */
const TITLE_DRAG_THRESHOLD_PX = 5

/**
 * Whether a release happened far enough from where the press landed to have been a drag.
 *
 * An event with no pointer at all — a keypress reaching the control as a click — has no place to have
 * travelled from, and so has moved none.
 */
function pressTravelled(origin: { x: number; y: number } | null, event: { clientX: number; clientY: number }): boolean {
  if (!origin) return false
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false
  return Math.abs(event.clientX - origin.x) > TITLE_DRAG_THRESHOLD_PX
    || Math.abs(event.clientY - origin.y) > TITLE_DRAG_THRESHOLD_PX
}

/** What a dragged task carries. The note tree uses the same shape for the same reason. */
export const TODO_DRAG_TYPE = 'application/x-inkstone-todo'

/**
 * The pointer a drag is worth drawing for.
 *
 * One spelling, shared by every surface in this feature that asks the question — a card deciding whether
 * to make itself draggable, the board deciding whether to draw a column's drop bands, the organizer
 * deciding which rows may be picked up. A phone gets the menus instead, so a second copy of the string
 * is a second answer to the same question the first time a device reports the two halves differently.
 */
export const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

/**
 * What a dragged *group* of them carries, beside the row under the pointer.
 *
 * Its own format rather than a second id in the first, because every surface that answers a drop today
 * reads one task id and would take a list for a name. A drag that started on an unpicked row writes
 * nothing here at all.
 */
export const TODO_DRAG_GROUP_TYPE = 'application/x-inkstone-todo-group'

/** Whether a drag over this surface is one of ours rather than a file from the desktop. */
export function isTodoTaskDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TODO_DRAG_TYPE)
}

/** Whether a drag is carrying files from outside the page — the other half of the same drop event. */
export function isFileDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

/** The files a drop is carrying, or nothing for a drag this page wrote itself. */
export function droppedFiles(event: React.DragEvent): File[] {
  return Array.from(event.dataTransfer.files ?? [])
}

/** The task a drop is carrying, or an empty string for a drag that is not ours. */
export function readTodoTaskDrag(event: React.DragEvent): string {
  return event.dataTransfer.getData(TODO_DRAG_TYPE)
}

/**
 * The group a drag wrote, or nothing for a bag that is not ours.
 *
 * A payload that will not parse is not a group: the caller falls back to the single id every task drag
 * carries, so a hand-edited or third-party bag moves the one row it names rather than none of them, and
 * says nothing about it.
 */
function parseCarriedGroup(carried: string): string[] {
  try {
    const parsed: unknown = JSON.parse(carried)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * Every task id a drop is carrying, in the order the drag wrote them.
 *
 * The picked group when the drag started on a row that was picked, and the one row underneath when it
 * did not — which is why a destination never has to ask which kind of drag it was handed.
 */
export function readTodoTaskDropIds(event: React.DragEvent): string[] {
  const single = event.dataTransfer.getData(TODO_DRAG_TYPE)
  const carried = event.dataTransfer.getData(TODO_DRAG_GROUP_TYPE)
  if (carried) {
    const group = parseCarriedGroup(carried)
    if (group.length > 0) return group
  }
  return single ? [single] : []
}

/** Where the pointer holds the group's label, so it does not sit under the finger and vanish. */
const DRAG_GHOST_ANCHOR_PX = 12

/**
 * The count a picked group wears while it is in the air.
 *
 * A browser paints a drag's ghost from a node the page holds, not from the row it photographed, so the
 * node is made for the gesture and taken away when the gesture ends: left in the document it is a
 * fragment of a finished drag nobody finished. It is parked outside the window rather than hidden,
 * because a node nothing lays out gives the browser nothing to draw.
 */
function appendGroupDragImage(count: number): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute('data-todo-drag-ghost', '')
  node.setAttribute('aria-hidden', 'true')
  node.className = [
    'fixed top-0 -left-[10000px]',
    'flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)]',
    'bg-[var(--bg-overlay)] px-2 py-1 shadow-[var(--shadow-pop)]',
    'text-[length:var(--text-12)] font-medium text-[var(--text-primary)]',
  ].join(' ')
  node.textContent = t('todo.drag.move_count', { count })
  document.body.appendChild(node)
  return node
}

/**
 * One write behind both the drag and the menu.
 *
 * The listing is read again rather than patched in place: a move changes the row's list and its
 * place relative to rows this page may not have read, and the server's order is the only one that
 * can say where it landed. The API layer is the only thing touched here; no view sorts locally.
 */
export async function moveTodoTask(
  id: string,
  placement: { beforeId: string | null; listId?: string | null },
): Promise<void> {
  try {
    await api.todos.move(id, placement)
    await useTodos.getState().load()
  } catch (error) {
    useUi.getState().toast({
      title: t('todo.toast.failed'),
      description: error instanceof Error ? error.message : String(error),
      tone: 'danger',
    })
  }
}

/**
 * The rows a manual order may move this one between, in the order the page read them.
 *
 * One function answers this because two questions depend on the same answer: the card's up and down
 * name a visible neighbour, and a keyboard jump to the top or the bottom has to land on the very same
 * row. The order is walked over the work the reader still owes — which is why a finished task answers
 * with nothing rather than with the open rows it sits above, and why the question is asked of the open
 * set twice rather than as one negation of `done`: a status that belongs to neither set has no place
 * in a manual order either, and that has to be the reading rather than the leftover.
 */
export function openTaskSiblings(tasks: readonly TodoTask[], task: TodoTask): TodoTask[] {
  if (!isTaskOpen(task.status)) return []
  return tasks.filter((entry) => isTaskOpen(entry.status) && entry.listId === task.listId)
}

/**
 * What a card's move menu may do, and whether it may be dragged.
 *
 * The siblings are the open rows of the card's own list in the order the page read them, which is the
 * order the server read. Up and down therefore name the visible neighbour, and "move down" anchors the
 * row before the sibling *after* that neighbour — the same "before this row" grammar a drop uses.
 *
 * Two questions about the pointer are answered apart, because a board does not always ask them together.
 * `dragEnabled` is whether this row may be picked up; `reorderEnabled` is whether another row may be
 * dropped into the gap beside it, with the line that promises so. Columns cut by status or list have
 * both; columns cut by priority want the first and refuse the second, since a hand-written place belongs
 * to a list and not to a priority — and a row that offered a gap it cannot fill is a line to nowhere.
 * Absent, `reorderEnabled` follows `dragEnabled`, which is every listing that has had the pair together
 * all along. Dragging needs a fine pointer either way: a phone gets the menu instead, which is why the
 * controls are built whether or not the pointer can drag.
 *
 * A drop may carry more than one row, and the row it lands beside is the anchor for every one of them.
 * The two drop halves are therefore called once per carried row, and one is waited for before the next
 * is sent: sent together they would reach the server in whatever order the network chose and the group
 * would land shuffled, while sent one after the other they take the same anchor in the order they left.
 * A control that answers at once — a column that only re-files a field — returns nothing, and waiting on
 * nothing is the same as not waiting.
 */
export interface TaskMoveControls {
  dragEnabled: boolean
  reorderEnabled?: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveToList: (listId: string | null) => void
  onDropBefore: (draggedId: string) => void | Promise<void>
  onDropAfter: (draggedId: string) => void | Promise<void>
}

export function useTaskMoves(enabled: boolean): (task: TodoTask) => TaskMoveControls | null {
  const tasks = useTodos((state) => state.tasks)
  const finePointer = useMediaQuery(FINE_POINTER_QUERY)
  return (task) => {
    if (!enabled) return null
    const siblings = openTaskSiblings(tasks, task)
    const index = siblings.findIndex((entry) => entry.id === task.id)
    if (index < 0) return null
    // A row is never placed beside itself, and a row crossing into this one's list names that list
    // beside the anchor — which is what keeps a move from carrying the number it had where it came from
    // into the middle of where it is going.
    const placeBefore = (draggedId: string, beforeId: string | null): Promise<void> | void => {
      if (draggedId === task.id) return
      const dragged = tasks.find((entry) => entry.id === draggedId)
      if (!dragged) return
      return moveTodoTask(draggedId, {
        beforeId,
        ...(dragged.listId === task.listId ? {} : { listId: task.listId }),
      })
    }
    return {
      dragEnabled: finePointer,
      reorderEnabled: finePointer,
      canMoveUp: index > 0,
      canMoveDown: index < siblings.length - 1,
      onMoveUp: () => {
        if (index > 0) void moveTodoTask(task.id, { beforeId: siblings[index - 1]!.id })
      },
      onMoveDown: () => {
        if (index < siblings.length - 1) {
          void moveTodoTask(task.id, { beforeId: siblings[index + 2]?.id ?? null })
        }
      },
      onMoveToList: (listId) => { void moveTodoTask(task.id, { beforeId: null, listId }) },
      onDropBefore: (draggedId) => placeBefore(draggedId, task.id),
      onDropAfter: (draggedId) => placeBefore(draggedId, siblings[index + 1]?.id ?? null),
    }
  }
}

export function TaskCard({ task, lists, bounds, timezone, onOpen, onStar, onUnplan, move, compact = false, showList = true }: {
  task: TodoTask
  lists: readonly TaskList[]
  bounds: { dayEnd: number; now: number }
  timezone: string
  onOpen: () => void
  onStar?: () => void
  /**
   * Takes a task the reader picked out of today. Only the today screen passes it, and only for rows
   * whose membership is the pick itself — a task merely due today has no plan to clear, and a button
   * that left it on screen would be a lie.
   */
  onUnplan?: () => void
  /**
   * The manual-order controls: drag on a desktop, the same moves in the card menu everywhere. Absent
   * where the order is not the reader's — the plan groups by day, and an explicit sort has its own.
   */
  move?: TaskMoveControls
  compact?: boolean
  /**
   * Whether the row names its list. A row on one list is already inside that list, so repeating the
   * name on every line is noise; the aggregate views (all, starred, plan, finished, tag) keep it.
   */
  showList?: boolean
}) {
  const toggle = useTodos((state) => state.toggleTask)
  const snooze = useTodos((state) => state.snoozeTask)
  const updateTask = useTodos((state) => state.updateTask)
  const startTimer = useTodos((state) => state.startTimer)
  const stopTimer = useTodos((state) => state.stopTimer)
  const selectionMode = useTodos((state) => state.selectedIds.size > 0)
  const selected = useTodos((state) => state.selectedIds.has(task.id))
  const toggleSelected = useTodos((state) => state.toggleSelected)
  const list = task.listId ? lists.find((entry) => entry.id === task.listId) ?? null : null
  // The row's colour identity: the task's own when it has one, its list's otherwise. The accent stays
  // the inbox's fallback here — a card's checkbox is the row's own mark — where the calendar, whose
  // chips sit beside other days' work, draws the neutral instead (`task-face.ts`).
  const colour = taskColorOf(task, lists, 'var(--accent)')
  const due = dueLabel(task.dueAt, bounds, timezone)
  /**
   * The two questions the card used to ask with one boolean.
   *
   * `finished` is what the tick and the strikethrough claim — the reader did this — and `owed` is what
   * every affordance for work still on the plate keys off: the stopwatch, the reminder rows, the late
   * date painted in the danger colour. While `done` was the only way a row could stop being owed the
   * two were the same question and one literal answered both. Ask them apart and a row in neither set
   * — the shape an abandoned task will arrive with — is drawn as what it is: off the plate, unticked,
   * and not offered the controls of work the reader still has.
   */
  const finished = isTaskDone(task.status)
  const owed = isTaskOpen(task.status)
  const progress = task.stepTotal > 0 ? t('todo.steps.progress', { done: task.stepDone, total: task.stepTotal }) : null
  /**
   * What this row's ledger says, and what it can be made to say.
   *
   * Three readings, none of them stored twice: the plan the reader made, the closed intervals the
   * ledger holds, and the instant of the one interval still running. The chip is shown when either
   * number means something, and the bar under a *tracked* row is the only one of the three that is
   * allowed to be seen moving — which is why it is the running row alone that wears it.
   */
  const estimateMs = task.timeEstimateMs ?? null
  const spentMs = task.timeSpentMs ?? 0
  const runningSince = task.runningSince ?? null
  /** Whether this row is the one interval the account is running. */
  const timed = runningSince !== null
  // The chip is the only door to a plan that is not the editor, so it is always on the row: a task
  // with neither an estimate nor logged time still has to be able to acquire its first one.
  // What that state shows is the hourglass alone — an empty label would read as a rendering bug.
  const timeLabel = estimateMs === null
    ? (spentMs > 0 ? formatTaskDuration(spentMs) : '')
    : `${formatTaskDuration(spentMs)} / ${formatTaskDuration(estimateMs)}`
  /** How far a tracked row has gone through its plan, as the share of the bar that is filled. */
  const estimateProgress = runningSince === null || estimateMs === null || estimateMs <= 0
    ? null
    : Math.min(ESTIMATE_BAR_FULL, Math.round(((spentMs + Math.max(0, bounds.now - runningSince)) / estimateMs) * ESTIMATE_BAR_FULL))
  const [estimateOpen, setEstimateOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * What the row says beside its name — the note, the status, the day, the priority, the list, the tags.
   *
   * The body's control carries a name of its own ("Open "Write the report""), and a name replaces the
   * text it sits on rather than adding to it, so what the row says has to be read to it as its
   * description. Without that, a row's due date and its unfinished steps would exist only in ink.
   */
  const notesId = useId()
  const metaId = useId()
  /** The point a right-click opened this row's menu at, or null while no menu is showing. */
  const rowMenu = useContextMenu()
  /** The row highlight a drag paints: the same before/after grammar the note tree uses. */
  const [dropState, setDropState] = useDropState<'none' | 'before' | 'after'>('none')
  /**
   * The two halves of the drag, which one column asks for apart from the other.
   *
   * Picking this row up and aiming at the gap beside it have always travelled together, and a listing
   * whose order is the reader's still sends them together. A board cut by priority is the one surface
   * that takes the first and declines the second, so the line below only ever belongs to `reorderable`.
   */
  const draggable = move?.dragEnabled === true
  const reorderable = move ? (move.reorderEnabled ?? move.dragEnabled) === true : false
  /**
   * Whether a file from outside the page is hovering over this row.
   *
   * The same five bail-outs the gap line needs: a drag that leaves the window, or one the reader
   * cancels, never fires `drop` on the row it was over, and a strip left up would be a promise the row
   * has no intention of keeping.
   */
  const [fileHover, setFileHover] = useDropState(false)
  /** The label this row's own drag hung on the page, while it is in the air. */
  const dragGhost = useRef<HTMLElement | null>(null)
  /**
   * The rows this drag carries when the row under the pointer is part of a picked group.
   *
   * Read from the store at the moment the pointer lets go rather than subscribed to: a row does not
   * re-render because another row was ticked, and a count that was a frame stale would be the one place
   * the ghost lied. Only rows the page has read are carried, so the number on the drag is exactly the
   * number of writes the drop can make, and the order is the page's own rather than the order the
   * reader happened to tick them in.
   */
  const pickedGroup = (): string[] => {
    const state = useTodos.getState()
    if (!state.selectedIds.has(task.id)) return []
    const group = state.tasks.filter((entry) => state.selectedIds.has(entry.id)).map((entry) => entry.id)
    // A group of one is the single row it always was, and "Move 1 items" is not a promise worth painting.
    return group.length > 1 ? group : []
  }
  /**
   * The long press a phone uses to enter selection mode.
   *
   * The timer lives beside the row rather than in the store: it belongs to the pointer that started it,
   * and a row scrolled away has nobody to finish the gesture. `suppressOpen` consumes the click that
   * follows the release, because without it the long press would select the row and then open it.
   */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressOpen = useRef(false)

  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    // A row that went away mid-drag would otherwise leave its count hanging on the page forever.
    dragGhost.current?.remove()
    dragGhost.current = null
  }, [])

  const cancelLongPress = (): void => {
    if (!pressTimer.current) return
    clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  const startLongPress = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // A mouse uses Command/Ctrl-click; its pointer-down must not arm a timer that a slow click would
    // turn into a selection.
    if (event.pointerType === 'mouse') return
    suppressOpen.current = false
    cancelLongPress()
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      suppressOpen.current = true
      toggleSelected(task.id)
    }, LONG_PRESS_MS)
  }

  /**
   * The title box, and the draft inside it.
   *
   * The text is the row's own and lives beside the row: it is gone the moment the box closes, whether
   * the reader committed it or not, and a rename that failed at the server says so with the store's own
   * toast rather than with a second one here. While it is open the row is not a drag source either —
   * `draggable` below hands that question back to the pointer.
   */
  const [titleOpen, setTitleOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleRef = useRef<HTMLButtonElement>(null)
  /** Where a press on the title landed, or null once the pointer has left it. */
  const titlePress = useRef<{ x: number; y: number } | null>(null)
  /** Whether that press had already travelled before the release was read. */
  const titleMoved = useRef(false)
  /** The box closed under the reader's hands, so the row's title takes the caret back. */
  const caretToTitle = useRef(false)

  useEffect(() => {
    if (titleOpen || !caretToTitle.current) return
    caretToTitle.current = false
    titleRef.current?.focus()
  }, [titleOpen])

  const openTitleBox = (): void => {
    caretToTitle.current = true
    setTitleDraft(task.title)
    setTitleOpen(true)
  }

  /**
   * The write the box leaves with: Enter, or walking away from it.
   *
   * Escape unmounts the field before it can blur, so the two exits cannot both answer one gesture.
   * A blank or unchanged title writes nothing — the row keeps the name it had rather than sending an
   * empty one the server would have to refuse.
   */
  const commitTitle = (): void => {
    if (!titleOpen) return
    caretToTitle.current = true
    setTitleOpen(false)
    const next = titleDraft.trim()
    if (next && next !== task.title) void updateTask(task.id, { title: next })
  }

  const closeTitleBox = (): void => {
    caretToTitle.current = true
    setTitleOpen(false)
  }

  /**
   * The answer every press on this row gives before it means anything of its own.
   *
   * The click that ends a long press is the selection's own, not a second press, and a row in a picked
   * group — or one Command/Ctrl-clicked into it — belongs to the bar rather than to itself.
   */
  const claimPress = (event: React.MouseEvent<HTMLButtonElement>): boolean => {
    if (suppressOpen.current) { suppressOpen.current = false; return true }
    if (selectionMode) { event.preventDefault(); toggleSelected(task.id); return true }
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); toggleSelected(task.id); return true }
    return false
  }

  const openRow = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (claimPress(event)) return
    onOpen()
  }

  /** The tap that renames: the row's own press, and nothing that travelled far enough to be a drag. */
  const pressTitle = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (claimPress(event)) return
    if (titleMoved.current || pressTravelled(titlePress.current, event)) return
    openTitleBox()
  }

  const titlePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    titlePress.current = { x: event.clientX, y: event.clientY }
    titleMoved.current = false
    startLongPress(event)
  }

  const titlePointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // Once the pointer is past the threshold the gesture is decided, whatever the release reports.
    if (!pressTravelled(titlePress.current, event)) return
    titleMoved.current = true
    cancelLongPress()
  }

  const titlePointerOff = (): void => {
    cancelLongPress()
    titlePress.current = null
  }

  /**
   * The right-click that opens this row's menu.
   *
   * A phone's long press is the row's selection gesture, and Android fires `contextmenu` underneath it
   * at about the same threshold — so a menu that opened beside it would answer a gesture the reader
   * made for a different reason. Either order is refused: the timer still armed means the press is in
   * flight, `suppressOpen` means it has already been taken as a selection. A mouse never arms either,
   * because `startLongPress` stands down for its pointer.
   */
  const openRowMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (pressTimer.current || suppressOpen.current) return
    rowMenu.onContextMenu(event)
  }

  /**
   * Places every row a drag carried beside this one, the next held until the last has landed.
   *
   * Each write names the same anchor, so the order they are sent in is the order they arrive in. Fired
   * together, they would land in whichever order the network answered and the group would read as a
   * shuffle nobody asked for.
   */
  const placeCarried = async (carried: readonly string[], after: boolean): Promise<void> => {
    if (!move) return
    for (const draggedId of carried) {
      await (after ? move.onDropAfter(draggedId) : move.onDropBefore(draggedId))
    }
  }
  // One set of rows, two ways to reach it: the kebab writes them as they have always been, and a
  // right-click opens the same list under a schedule strip. `task-menu.ts` builds both, because a card
  // that kept a second copy of the list would answer one question twice.
  const menuHandlers = {
    timezone,
    now: bounds.now,
    lists,
    move,
    update: (patch: Record<string, unknown>) => { void updateTask(task.id, patch) },
    snooze: (minutes: SnoozeMinutes) => { void snooze(task.id, minutes) },
  }
  const menuItems = buildTaskMenuItems(task, { ...menuHandlers, onClose: () => setMenuOpen(false) })
  // A row the reader no longer owes has nothing left to be reminded about, so the right-click leaves
  // those rows out rather than offering a notification nobody will hear — answered from the open set,
  // not from the absence of a `done`, so a row in neither set is left out too. While rows are picked
  // the group answers instead, and this list is not built at all.
  const contextItems = rowMenu.point && !selectionMode
    ? buildTaskContextMenuItems(task, {
        ...menuHandlers,
        onClose: rowMenu.close,
        snooze: owed ? menuHandlers.snooze : undefined,
      })
    : []

  return (
    <article
      data-todo-selected={selected ? '' : undefined}
      data-todo-draggable={draggable ? '' : undefined}
      draggable={draggable && !titleOpen ? true : undefined}
      onDragStart={(event) => {
        if (!draggable) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(TODO_DRAG_TYPE, task.id)
        event.dataTransfer.effectAllowed = 'move'
        // A picked row drags its whole group, and says so on the drag rather than in the row after it.
        const group = pickedGroup()
        if (group.length === 0) return
        event.dataTransfer.setData(TODO_DRAG_GROUP_TYPE, JSON.stringify(group))
        dragGhost.current = appendGroupDragImage(group.length)
        event.dataTransfer.setDragImage(dragGhost.current, DRAG_GHOST_ANCHOR_PX, DRAG_GHOST_ANCHOR_PX)
      }}
      onDragEnd={() => {
        dragGhost.current?.remove()
        dragGhost.current = null
      }}
      onDragOver={(event) => {
        if (isTodoTaskDrag(event)) {
          if (!reorderable) return
          // The row owns the drop it is under: without this the board card behind it would append the
          // task to the list instead of placing it where the reader pointed.
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5
          setDropState(ratio < 0.5 ? 'before' : 'after')
          return
        }
        // The other half of the same event: a file from outside the page is not a row being moved, and
        // it needs this row to say out loud that it will take it.
        if (!isFileDrag(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setFileHover(true)
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setDropState('none')
          setFileHover(false)
        }
      }}
      onDrop={(event) => {
        if (isTodoTaskDrag(event)) {
          // A drag this row cannot read is not its own to swallow: taking it would leave the surface
          // behind — the column, the board, the day the pointer is really over — never hearing about it.
          if (!move || !reorderable) return
          event.preventDefault()
          event.stopPropagation()
          setDropState('none')
          const carried = readTodoTaskDropIds(event).filter((id) => id !== task.id)
          if (carried.length === 0) return
          void placeCarried(carried, dropState === 'after')
          return
        }
        if (!isFileDrag(event)) return
        const files = droppedFiles(event)
        if (files.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        setFileHover(false)
        // The route answers for itself: what the client refused, what landed, and why not.
        void attachFilesToTask(task.id, files)
      }}
      className={cn(
        'group relative flex min-w-0 items-start gap-2 rounded-[var(--r-md)] border-b border-[var(--border-subtle)] px-2 py-1.5 transition-colors duration-[var(--dur-fast)] last:border-b-0',
        'hover:bg-[var(--bg-hover)]',
        selected ? 'bg-[var(--accent-soft)]' : '',
        compact ? 'py-1' : 'py-1.5',
      )}
    >
      {dropState === 'before' && (
        <span aria-hidden="true" data-todo-drop-line="before" className="pointer-events-none absolute top-0 right-1 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
      )}
      {dropState === 'after' && (
        <span aria-hidden="true" data-todo-drop-line="after" className="pointer-events-none absolute right-1 bottom-0 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
      )}
      {estimateProgress !== null && (
        // The plan being eaten, drawn where the reader's eye already is.
        //
        // Silent by design and marked as such: the numbers it pictures are in the row's own text, so
        // a second announcement of the same fact would be read twice. The width is a runtime value and
        // therefore a CSS variable rather than a class, and the strip is the row's — measured against
        // the row it belongs to, not floated over the page.
        <span
          aria-hidden="true"
          data-todo-estimate-bar=""
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-[var(--bg-active)]"
          style={{ ['--todo-estimate-progress' as string]: `${estimateProgress}` }}
        >
          <span className="block h-full w-[calc(var(--todo-estimate-progress)*1%)] bg-[var(--accent)]" />
        </span>
      )}
      {fileHover && (
        // The row says what it will do with the file before the pointer lets go, in the same words the
        // attachment hub uses for the same gesture. The toast is what a reader is told afterwards; this
        // is the mark a pointer reads, so it is not announced twice.
        <span
          aria-hidden="true"
          data-todo-attach-hint=""
          className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] text-[length:var(--text-11)] font-medium text-[var(--accent)]"
        >
          <Paperclip size={12} />
          {t('attachments.drag_drop_hint')}
        </span>
      )}
      {selectionMode ? (
        // The selection tick takes the completion box's place rather than sitting beside it: while the
        // mode is on, a press on the left of a row means "pick this row", never "finish it".
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected
            ? t('todo.a11y.deselect_task', { title: task.title })
            : t('todo.a11y.select_task', { title: task.title })}
          onClick={() => toggleSelected(task.id)}
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
        >
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border-2 transition-colors',
              selected
                ? 'border-transparent bg-[var(--accent)] text-[var(--accent-contrast)]'
                : 'border-[var(--border-strong)] bg-transparent',
            )}
          >
            {selected && <Check size={12} strokeWidth={3} />}
          </span>
        </button>
      ) : (
        <button
          type="button"
          role="checkbox"
          // Three answers spelled out, rather than one boolean and its leftover: ticked for the row the
          // reader finished, empty for the row they still owe, and `mixed` for a row in neither set. The
          // unchecked box is the reading of work still to do, and an abandoned row is not that. The name
          // tracks what a press really writes, which is `toggledStatus`: work still owed goes finished,
          // and a row that already stopped being owed — finished or abandoned — goes back to `todo`. So
          // an abandoned row is named "reopen", not "mark done": one tap takes the abandonment back.
          aria-checked={finished ? true : owed ? false : 'mixed'}
          aria-label={owed
            ? t('todo.a11y.mark_done', { title: task.title })
            : t('todo.a11y.mark_open', { title: task.title })}
          onClick={() => { void toggle(task) }}
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full transition-transform duration-[var(--dur-fast)] active:scale-90 motion-reduce:transform-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
        >
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border-2 transition-[background-color,border-color,transform] duration-[var(--dur-base)] ease-[var(--ease-spring)]',
              finished ? 'border-transparent text-[var(--accent-contrast)]' : 'bg-transparent',
            )}
            style={{ borderColor: colour, backgroundColor: finished ? colour : undefined }}
          >
            {finished && <Check size={12} strokeWidth={3} />}
          </span>
        </button>
      )}

      {/*
       * The body of the row, and the two presses it answers.
       *
       * The control underneath is the row's whole-body press it always was: it covers the description,
       * the meta line and the empty space around them, and it is still the way into the task. The title
       * sits on top of it — in flow, but positioned and later in the order, which is what puts a press
       * on the word itself above a press anywhere else. `pointer-events-none` on the wrapper is what
       * keeps the space beside a short title part of the body rather than part of the title.
       */}
      <div className={cn(
        'relative min-w-0 flex-1',
        // The row a reader taps to open the task is the whole card body, and on a phone it has to be
        // a finger's height: the title alone was 22px once the card got its width back.
        compact && 'flex min-h-11 flex-col justify-center',
      )}>
        {!titleOpen && (
          <button
            type="button"
            data-todo-details={task.id}
            aria-label={t('todo.a11y.open_task', { title: task.title })}
            aria-describedby={!compact && task.description ? `${notesId} ${metaId}` : metaId}
            onClick={openRow}
            onPointerDown={startLongPress}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onContextMenu={openRowMenu}
            className="absolute inset-0 rounded-[var(--r-md)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          />
        )}
        <span className="pointer-events-none relative flex min-w-0 items-start gap-1.5">
          {/* The task's own glyph, when it has picked one. A task that has not keeps exactly the row
              it had before tasks could wear a face — no placeholder, and the colour beside the
              checkbox still says which list the work belongs to. */}
          {task.icon && <ListIcon icon={task.icon} size={14} className="mt-0.5 shrink-0 leading-none" />}
          {titleOpen ? (
            <Input
              autoFocus
              aria-label={t('todo.task.title_label')}
              value={titleDraft}
              onChange={(event) => { setTitleDraft(event.target.value) }}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                // Enter is the commit and Escape the way back out. Both cancel the keystroke: the first
                // so the browser does not activate the row behind the field, the second so the app's
                // own Escape does not step the reader out of a screen they were never on.
                if (event.key === 'Enter') { event.preventDefault(); commitTitle() }
                else if (event.key === 'Escape') { event.preventDefault(); closeTitleBox() }
              }}
              className={cn(
                'pointer-events-auto -ml-1 w-auto min-w-0 flex-1 h-auto border-transparent px-1 py-0 leading-snug md:h-auto',
                // The box wears the row's own type and keeps its border transparent until it is
                // focused, so opening it moves the title by nothing but the caret. The muted half is
                // "no longer owed", which is the same reading as the row's own title below.
                owed ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
              )}
            />
          ) : (
            <button
              ref={titleRef}
              type="button"
              data-todo-open={task.id}
              onClick={pressTitle}
              onPointerDown={titlePointerDown}
              onPointerMove={titlePointerMove}
              onPointerUp={cancelLongPress}
              onPointerCancel={titlePointerOff}
              onPointerLeave={titlePointerOff}
              onContextMenu={openRowMenu}
              className={cn(
                'line-clamp-2 pointer-events-auto block min-w-0 break-words rounded-[var(--r-sm)] text-left text-[length:var(--text-13)] leading-snug',
                // The strike is the claim of a row that was finished; a row in neither set is muted
                // like the work that is off the plate, and does not borrow that claim.
                finished
                  ? 'text-[var(--text-tertiary)] line-through'
                  : owed
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-tertiary)]',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
              )}
            >
              {task.title}
            </button>
          )}
        </span>
        {!compact && task.description && (
          <span id={notesId} className="mt-0.5 line-clamp-1 break-words text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {task.description}
          </span>
        )}
        <span id={metaId} className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {/* A status the reader can set has to be one they can see. The word carries it; the dot is
              only the accent that makes a started row findable at a glance. */}
          {task.status === 'in_progress' && (
            <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)]">
              <CircleDot size={12} aria-hidden="true" />
              {t('todo.status.in_progress')}
            </span>
          )}
          {due && (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[length:var(--text-11)]',
                // A date only runs late against work still owed: painting an abandoned row in the
                // danger colour would ask for attention the reader has already refused.
                due.overdue && owed ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]',
              )}
            >
              {due.overdue && owed && <span className="sr-only">{t('todo.a11y.overdue')}</span>}
              {due.text}
            </span>
          )}
          {task.priority !== 'medium' && (
            <span className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              <span className={cn('size-1.5 rounded-full', priorityDot(task.priority))} aria-hidden="true" />
              {priorityLabel(task.priority)}
            </span>
          )}
          {progress && (
            <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{progress}</span>
          )}
          {(
            // The ledger on the row, and the door that changes the plan behind it.
            //
            // It has to be lifted out of the row's own press: the body of a card is covered by an
            // absolutely positioned button, and a static sibling painted under it would take the
            // reader's click as "open the task" — an estimate control that opens something else is
            // exactly how a hit line goes missing. `relative` plus `pointer-events-auto` is the same
            // recipe the title's own box uses to sit above that layer.
            <button
              type="button"
              data-todo-estimate=""
              aria-label={t('todo.time.edit_aria', { title: task.title })}
              onClick={() => { setEstimateOpen(true) }}
              className="pointer-events-auto relative inline-flex min-h-7 items-center gap-1 rounded-full border border-[var(--border-subtle)] px-1.5 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-6"
            >
              <Hourglass size={11} aria-hidden="true" />
              {timeLabel}
            </button>
          )}
          {showList && !compact && list && (
            <span className="inline-flex max-w-[130px] min-w-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {list.icon
                ? <ListIcon icon={list.icon} size={11} className="shrink-0" />
                : <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} aria-hidden="true" />}
              <span className="truncate">{list.name}</span>
            </span>
          )}
          {task.tags.slice(0, 2).map((tag) => (
            <TagPill
              key={tag.id}
              tone="tinted"
              label={tag.name}
              color={tag.color}
              className="max-w-[120px]"
            />
          ))}
          {task.tags.length > 2 && (
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">+{task.tags.length - 2}</span>
          )}
        </span>
      </div>

      {/* A board card carries no star of its own. Two cards across a phone leave about 150px, and a
          36px column on the right took so much of it that a four-character title wrapped one character
          per line; the reference card has an icon, a name and the rows, and the star is toggled where
          the task is read in full — the list rows and the editor. */}
      <span className="flex shrink-0 items-center gap-0.5">
        {/*
         * The stopwatch, and the one thing it is not: a way to finish the task.
         *
         * Pressing it starts the interval and moves the row to `in_progress` in the same gesture, because
         * a row that is being timed while still reading `todo` would answer "am I working on this" twice.
         * Pressing it again only stops the interval — the status stays wherever the reader left it, and
         * the one door to `done` is the checkbox's and the editor's. A running row keeps the control
         * visible with the pointer away, since putting a timer down has to be reachable from wherever the
         * reader happened to be looking; the idle one comes and goes with the hover, the way the star does.
         * Timing is asked of the open set, so a row that is neither finished nor owed — and so is nobody's
         * work in progress — offers no stopwatch to start.
         */}
        {!selectionMode && !compact && (owed || timed) && (
          <button
            type="button"
            data-todo-timer={task.id}
            aria-label={timed
              ? t('todo.timer.stop_aria', { title: task.title })
              : t('todo.timer.start_aria', { title: task.title })}
            onClick={() => { void (timed ? stopTimer(task.id) : startTimer(task)) }}
            className={cn(
              'flex size-9 items-center justify-center rounded-full transition-colors md:size-7',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
              timed
                ? 'text-[var(--accent)] opacity-100'
                : 'text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
            )}
          >
            {timed ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
        )}
        {/* A row being picked for a batch offers no single-row writes: the star, the unplan and the
            snooze menu would each act on one task while the bar acts on all of them. */}
        {!selectionMode && !compact && (
          <button
            type="button"
            aria-label={task.starred ? t('todo.task.unstar') : t('todo.task.star')}
            aria-pressed={task.starred}
            onClick={onStar}
            className={cn(
              'flex size-9 items-center justify-center rounded-full transition-colors md:size-7',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
              task.starred ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]',
              // A star that only appears on hover is a star a thumb never finds.
              task.starred ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
            )}
          >
            <Star size={14} fill={task.starred ? 'currentColor' : 'none'} />
          </button>
        )}
        {!selectionMode && !compact && onUnplan && (
          <button
            type="button"
            aria-label={t('todo.today.remove', { title: task.title })}
            title={t('todo.today.remove', { title: task.title })}
            onClick={onUnplan}
            className="flex size-9 items-center justify-center rounded-full text-[var(--text-quaternary)] hover:text-[var(--danger)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
          >
            <CalendarMinus size={14} />
          </button>
        )}
        {/* A row the reader no longer owes has nothing left to be reminded about — finished or not — so
            the kebab is offered by the cards that still carry work, in the words the editor uses. */}
        {!selectionMode && owed && (
          <button
            ref={menuRef}
            type="button"
            aria-label={`${t('todo.task.actions')}: ${task.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
            className="flex size-11 items-center justify-center rounded-full text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </span>
      <Menu anchor={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} align="end" width={184} label={t('todo.task.actions')} />
      <EstimateDialog
        key={task.id}
        open={estimateOpen}
        title={task.title}
        estimate={estimateMs}
        onClose={() => { setEstimateOpen(false) }}
        onSave={(value) => {
          setEstimateOpen(false)
          // Nothing is sent when the number did not change: a save that rewrote an identical estimate
          // would spend the row's revision and offer an undo for a thing the reader never altered.
          if (value !== estimateMs) void updateTask(task.id, { timeEstimate: value })
        }}
      />
      {/*
       * One menu per right-click, and which one it is follows the mode the reader is in. While rows are
       * picked every action belongs to the group, so the bar's own vocabulary answers; otherwise the row
       * answers with its schedule strip above the rows the kebab offers.
       */}
      {rowMenu.point && (selectionMode
        ? <BatchContextMenu point={rowMenu.point} onClose={rowMenu.close} />
        : (
          <Menu
            anchor={rowMenu.point}
            open
            onClose={rowMenu.close}
            items={contextItems}
            width={TASK_ROW_MENU_WIDTH}
            label={t('todo.task.actions')}
          />
        ))}
    </article>
  )
}
