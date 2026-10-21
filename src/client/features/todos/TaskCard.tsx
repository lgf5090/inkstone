/**
 * One task, as a card.
 *
 * The same component draws a board card, a row in the plan view and a line inside a list, because
 * those are the same object seen at three densities — a second implementation would drift the moment
 * one of them learned about steps or tags. The checkbox is a real `role="checkbox"` button with a
 * 44px hit area; the visible circle is 20px, which is what the reference app shows.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CalendarMinus, Check, CircleDot, FolderInput, MoreHorizontal, Star } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useDropState } from '../../lib/drop-state'
import { useMediaQuery } from '../../lib/hooks'
import { Menu, MenuSubmenuList, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useTodos, snoozeLabel } from './store'
import { dueLabel, priorityDot, priorityLabel } from './todo-ui'
import { SNOOZE_MINUTES, type TaskList, type TodoTask } from '@shared/todos/model'

/** How long a finger has to stay down before the row joins a selection instead of opening. */
const LONG_PRESS_MS = 500

/** What a dragged task carries. The note tree uses the same shape for the same reason. */
export const TODO_DRAG_TYPE = 'application/x-inkstone-todo'

/** Whether a drag over this surface is one of ours rather than a file from the desktop. */
export function isTodoTaskDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TODO_DRAG_TYPE)
}

/** The task a drop is carrying, or an empty string for a drag that is not ours. */
export function readTodoTaskDrag(event: React.DragEvent): string {
  return event.dataTransfer.getData(TODO_DRAG_TYPE)
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
 * What a card's move menu may do, and whether it may be dragged.
 *
 * The siblings are the rows of the card's own list in the order the page arrived in, which is the
 * order the server read. Up and down therefore name the visible neighbour, and "move down" anchors
 * the row before the sibling *after* that neighbour — the same "before this row" grammar a drop
 * uses. Dragging needs a fine pointer: a phone gets the menu instead, which is why the controls are
 * built whether or not the pointer can drag.
 */
export interface TaskMoveControls {
  dragEnabled: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveToList: (listId: string | null) => void
  onDropBefore: (draggedId: string) => void
  onDropAfter: (draggedId: string) => void
}

export function useTaskMoves(enabled: boolean): (task: TodoTask) => TaskMoveControls | null {
  const tasks = useTodos((state) => state.tasks)
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)')
  return (task) => {
    if (!enabled) return null
    const siblings = tasks.filter((entry) => entry.listId === task.listId)
    const index = siblings.findIndex((entry) => entry.id === task.id)
    if (index < 0) return null
    const placeBefore = (draggedId: string, beforeId: string | null): void => {
      if (draggedId === task.id) return
      const dragged = tasks.find((entry) => entry.id === draggedId)
      if (!dragged) return
      void moveTodoTask(draggedId, {
        beforeId,
        ...(dragged.listId === task.listId ? {} : { listId: task.listId }),
      })
    }
    return {
      dragEnabled: finePointer,
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

export function TaskCard({ task, lists, bounds, timezone, onOpen, onStar, onUnplan, move, compact = false }: {
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
}) {
  const toggle = useTodos((state) => state.toggleTask)
  const snooze = useTodos((state) => state.snoozeTask)
  const updateTask = useTodos((state) => state.updateTask)
  const selectionMode = useTodos((state) => state.selectedIds.size > 0)
  const selected = useTodos((state) => state.selectedIds.has(task.id))
  const toggleSelected = useTodos((state) => state.toggleSelected)
  const list = task.listId ? lists.find((entry) => entry.id === task.listId) ?? null : null
  const colour = list?.color ?? 'var(--accent)'
  const due = dueLabel(task.dueAt, bounds, timezone)
  const done = task.status === 'done'
  const progress = task.stepTotal > 0 ? t('todo.steps.progress', { done: task.stepDone, total: task.stepTotal }) : null
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /** The row highlight a drag paints: the same before/after grammar the note tree uses. */
  const [dropState, setDropState] = useDropState<'none' | 'before' | 'after'>('none')
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

  const openRow = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // The click that ends a long press is the selection's own, not a second press on the row.
    if (suppressOpen.current) { suppressOpen.current = false; return }
    if (selectionMode) { event.preventDefault(); toggleSelected(task.id); return }
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); toggleSelected(task.id); return }
    onOpen()
  }
  // The same four durations the editor and the notification row offer, so "10 minutes" means one
  // thing wherever the reader reads it. The status rows come first, and the rule between them is
  // what keeps "start this" from reading as one more snooze preset.
  const statusItems: MenuItem[] = task.status === 'in_progress'
    ? [{
        id: 'status-todo',
        label: t('todo.status.mark_todo'),
        onSelect: () => {
          setMenuOpen(false)
          void updateTask(task.id, { status: 'todo' })
        },
      }]
    : task.status === 'todo'
      ? [{
          id: 'status-in-progress',
          label: t('todo.status.mark_in_progress'),
          onSelect: () => {
            setMenuOpen(false)
            void updateTask(task.id, { status: 'in_progress' })
          },
        }]
      : []
  // The manual-order rows. They live in the menu rather than on a draggable handle alone because a
  // phone cannot drag and a keyboard never could: this is the equivalent path, not a secondary one.
  const moveTargets: { id: string; name: string }[] = move
    ? [
        ...(task.listId !== null ? [{ id: 'inbox', name: t('todo.smart.inbox') }] : []),
        ...lists
          .filter((list) => list.id !== task.listId)
          .map((list) => ({ id: list.id, name: list.name })),
      ]
    : []
  const moveItems: MenuItem[] = move
    ? [
        {
          id: 'move-up',
          label: t('todo.move.up'),
          icon: <ArrowUp size={13} />,
          disabled: !move.canMoveUp,
          separatorBefore: statusItems.length > 0,
          onSelect: () => {
            setMenuOpen(false)
            move.onMoveUp()
          },
        },
        {
          id: 'move-down',
          label: t('todo.move.down'),
          icon: <ArrowDown size={13} />,
          disabled: !move.canMoveDown,
          onSelect: () => {
            setMenuOpen(false)
            move.onMoveDown()
          },
        },
        {
          id: 'move-to-list',
          label: t('todo.move.to_list'),
          icon: <FolderInput size={13} />,
          disabled: moveTargets.length === 0,
          submenu: ({ closeMenu }) => (
            <MenuSubmenuList
              label={t('todo.move.to_list')}
              items={moveTargets.map((target) => ({
                id: `move-to-${target.id}`,
                label: target.name,
                onSelect: () => {
                  closeMenu()
                  move.onMoveToList(target.id === 'inbox' ? null : target.id)
                },
              }))}
            />
          ),
        },
      ]
    : []
  const snoozeItems: MenuItem[] = SNOOZE_MINUTES.map((minutes, index) => ({
    id: `snooze-${minutes}`,
    label: snoozeLabel(minutes),
    separatorBefore: index === 0 && statusItems.length + moveItems.length > 0,
    onSelect: () => {
      setMenuOpen(false)
      void snooze(task.id, minutes)
    },
  }))
  const menuItems = [...statusItems, ...moveItems, ...snoozeItems]

  return (
    <article
      data-todo-selected={selected ? '' : undefined}
      data-todo-draggable={move?.dragEnabled ? '' : undefined}
      draggable={move?.dragEnabled && !selectionMode ? true : undefined}
      onDragStart={(event) => {
        if (!move?.dragEnabled) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(TODO_DRAG_TYPE, task.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!move?.dragEnabled || !isTodoTaskDrag(event)) return
        // The row owns the drop it is under: without this the board card behind it would append the
        // task to the list instead of placing it where the reader pointed.
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5
        setDropState(ratio < 0.5 ? 'before' : 'after')
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropState('none')
      }}
      onDrop={(event) => {
        if (!move?.dragEnabled) return
        event.preventDefault()
        event.stopPropagation()
        setDropState('none')
        const draggedId = readTodoTaskDrag(event)
        if (!draggedId || draggedId === task.id) return
        if (dropState === 'after') move.onDropAfter(draggedId)
        else move.onDropBefore(draggedId)
      }}
      className={cn(
        'group relative flex min-w-0 items-start gap-2 rounded-[var(--r-md)] px-2 py-1.5 transition-colors duration-[var(--dur-fast)]',
        'hover:bg-[var(--bg-hover)]',
        selected ? 'bg-[var(--accent-soft)]' : '',
        compact ? 'py-1' : 'py-1.5',
      )}
    >
      {dropState === 'before' && (
        <span aria-hidden="true" className="pointer-events-none absolute top-0 right-1 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
      )}
      {dropState === 'after' && (
        <span aria-hidden="true" className="pointer-events-none absolute right-1 bottom-0 left-1 h-0.5 rounded-full bg-[var(--accent)]" />
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
          aria-checked={done}
          aria-label={done
            ? t('todo.a11y.mark_open', { title: task.title })
            : t('todo.a11y.mark_done', { title: task.title })}
          onClick={() => { void toggle(task) }}
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
        >
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border-2 transition-colors',
              done ? 'border-transparent text-[var(--accent-contrast)]' : 'bg-transparent',
            )}
            style={{ borderColor: colour, backgroundColor: done ? colour : undefined }}
          >
            {done && <Check size={12} strokeWidth={3} />}
          </span>
        </button>
      )}

      <button
        type="button"
        data-todo-open={task.id}
        onClick={openRow}
        onPointerDown={startLongPress}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={(event) => { if (selectionMode) event.preventDefault() }}
        className={cn(
          'min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          // The row a reader taps to open the task is the whole card body, and on a phone it has to be
          // a finger's height: the title alone was 22px once the card got its width back.
          compact && 'flex min-h-11 flex-col justify-center',
        )}
      >
        <span
          className={cn(
            'block break-words text-[length:var(--text-13)] leading-snug',
            done ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]',
          )}
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {task.title}
        </span>
        {!compact && task.description && (
          <span className="mt-0.5 block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {task.description}
          </span>
        )}
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
                due.overdue && !done ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]',
              )}
            >
              {due.overdue && !done && <span className="sr-only">{t('todo.a11y.overdue')}</span>}
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
          {task.tags.slice(0, 2).map((tag) => (
            <span
              key={tag.id}
              className="max-w-[120px] truncate rounded-[var(--r-sm)] px-1.5 py-px text-[length:var(--text-10-5)]"
              style={{
                color: tag.color ?? 'var(--text-tertiary)',
                backgroundColor: `color-mix(in oklab, ${tag.color ?? 'var(--text-tertiary)'} 12%, transparent)`,
              }}
            >
              {tag.name}
            </span>
          ))}
          {task.tags.length > 2 && (
            <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">+{task.tags.length - 2}</span>
          )}
        </span>
      </button>

      {/* A board card carries no star of its own. Two cards across a phone leave about 150px, and a
          36px column on the right took so much of it that a four-character title wrapped one character
          per line; the reference card has an icon, a name and the rows, and the star is toggled where
          the task is read in full — the list rows and the editor. */}
      <span className="flex shrink-0 flex-col items-end gap-1">
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
        {!compact && list && (
          <span className="max-w-[84px] truncate pr-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{list.name}</span>
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
        {/* A finished task has nothing left to be reminded about; every other card offers the same
            four durations the editor does. */}
        {!selectionMode && !done && (
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
    </article>
  )
}
