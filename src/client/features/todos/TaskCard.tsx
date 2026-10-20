/**
 * One task, as a card.
 *
 * The same component draws a board card, a row in the plan view and a line inside a list, because
 * those are the same object seen at three densities — a second implementation would drift the moment
 * one of them learned about steps or tags. The checkbox is a real `role="checkbox"` button with a
 * 44px hit area; the visible circle is 20px, which is what the reference app shows.
 */

import { useRef, useState } from 'react'
import { CalendarMinus, Check, MoreHorizontal, Star } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Menu, type MenuItem } from '../../components/overlay'
import { useTodos, snoozeLabel } from './store'
import { dueLabel, priorityDot, priorityLabel } from './todo-ui'
import { SNOOZE_MINUTES, type TaskList, type TodoTask } from '@shared/todos/model'

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
  const list = task.listId ? lists.find((entry) => entry.id === task.listId) ?? null : null
  const colour = list?.color ?? 'var(--accent)'
  const due = dueLabel(task.dueAt, bounds, timezone)
  const done = task.status === 'done'
  const progress = task.stepTotal > 0 ? t('todo.steps.progress', { done: task.stepDone, total: task.stepTotal }) : null
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
      className={cn(
        'group flex min-w-0 items-start gap-2 rounded-[var(--r-md)] px-2 py-1.5 transition-colors duration-[var(--dur-fast)]',
        'hover:bg-[var(--bg-hover)]',
        compact ? 'py-1' : 'py-1.5',
      )}
    >
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

      <button
        type="button"
        data-todo-open={task.id}
        onClick={onOpen}
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
        {!compact && (
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
        {!compact && onUnplan && (
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
        {!done && (
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
