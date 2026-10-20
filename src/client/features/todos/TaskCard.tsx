/**
 * One task, as a card.
 *
 * The same component draws a board card, a row in the plan view and a line inside a list, because
 * those are the same object seen at three densities — a second implementation would drift the moment
 * one of them learned about steps or tags. The checkbox is a real `role="checkbox"` button with a
 * 44px hit area; the visible circle is 20px, which is what the reference app shows.
 */

import { useEffect, useRef, useState } from 'react'
import { CalendarMinus, Check, MoreHorizontal, Star } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Menu, type MenuItem } from '../../components/overlay'
import { useTodos, snoozeLabel } from './store'
import { dueLabel, priorityDot, priorityLabel } from './todo-ui'
import { SNOOZE_MINUTES, type TaskList, type TodoTask } from '@shared/todos/model'

/** How long a finger has to stay down before the row joins a selection instead of opening. */
const LONG_PRESS_MS = 500

export function TaskCard({ task, lists, bounds, timezone, onOpen, onStar, onUnplan, compact = false }: {
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
  compact?: boolean
}) {
  const toggle = useTodos((state) => state.toggleTask)
  const snooze = useTodos((state) => state.snoozeTask)
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
  // thing wherever the reader reads it.
  const snoozeItems: MenuItem[] = SNOOZE_MINUTES.map((minutes) => ({
    id: `snooze-${minutes}`,
    label: snoozeLabel(minutes),
    onSelect: () => {
      setMenuOpen(false)
      void snooze(task.id, minutes)
    },
  }))

  return (
    <article
      data-todo-selected={selected ? '' : undefined}
      className={cn(
        'group flex min-w-0 items-start gap-2 rounded-[var(--r-md)] px-2 py-1.5 transition-colors duration-[var(--dur-fast)]',
        'hover:bg-[var(--bg-hover)]',
        selected ? 'bg-[var(--accent-soft)]' : '',
        compact ? 'py-1' : 'py-1.5',
      )}
    >
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
            aria-label={`${t('todo.snooze.label')}: ${task.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
            className="flex size-9 items-center justify-center rounded-full text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:size-7"
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </span>
      <Menu anchor={menuRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={snoozeItems} align="end" width={184} label={t('todo.snooze.label')} />
    </article>
  )
}
