/**
 * One day, in full: everything due on it, with the controls a calendar cell has no room for.
 *
 * A month cell can show three titles; the panel is where the rest of the day is read and acted on. It
 * is a right-hand drawer on a wide window and a bottom sheet on a phone — the two shapes the app
 * already uses — and every row is the same task the list views draw: a checkbox that completes it, a
 * title that opens it, and the list and priority it carries.
 */
import { CalendarPlus, Clock } from 'lucide-react'
import { localDate, toLocalMinute } from '@shared/assistant-time'
import type { TaskList, TodoTask } from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import { t, localeTag } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { Drawer, Modal } from '../../components/overlay'
import { ListIcon } from './list-icons'
import { priorityDot, priorityLabel } from './todo-ui'

/** The time a task reads at, or null for an all-day one. */
function timeOf(task: TodoTask, timezone: string): string | null {
  if (task.dueAt === null) return null
  const minute = toLocalMinute(task.dueAt, timezone)
  return minute.endsWith('T23:59') ? null : minute.slice(11)
}

/** The tasks the panel lists: due that day, or spanning across it. */
function tasksOfDay(tasks: readonly TodoTask[], dayKey: string, timezone: string): TodoTask[] {
  return tasks
    .filter((task) => {
      if (isTaskDone(task.status) || task.dueAt === null) return false
      const end = localDate(task.dueAt, timezone)
      const start = task.startAt != null ? localDate(task.startAt, timezone) : end
      return dayKey >= start && dayKey <= end
    })
    .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
}

function DayBody({ dayKey, tasks, lists, timezone, onOpenTask, onToggle, onAdd }: {
  dayKey: string
  tasks: readonly TodoTask[]
  lists: readonly TaskList[]
  timezone: string
  onOpenTask: (task: TodoTask) => void
  onToggle: (task: TodoTask) => void
  onAdd: () => void
}) {
  const rows = tasksOfDay(tasks, dayKey, timezone)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {rows.map((task) => {
          const list = task.listId ? lists.find((entry) => entry.id === task.listId) ?? null : null
          const time = timeOf(task, timezone)
          return (
            <li key={task.id} data-agenda-task={task.id} className="flex items-start gap-2 rounded-[var(--r-md)] px-1 py-1.5 hover:bg-[var(--bg-hover)]">
              <Checkbox
                checked={false}
                onChange={() => onToggle(task)}
                label={<span className="sr-only">{t('todo.a11y.mark_done', { title: task.title })}</span>}
                className="mt-0.5 shrink-0"
              />
              <button type="button" onClick={() => onOpenTask(task)} className="min-w-0 flex-1 text-left">
                <span className="flex min-w-0 items-center gap-1.5">
                  {time && (
                    <span className="inline-flex shrink-0 items-center gap-1 tabular text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                      <Clock size={10} aria-hidden="true" />{time}
                    </span>
                  )}
                  <span className="min-w-0 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{task.title}</span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2">
                  {list && (
                    <span className="inline-flex min-w-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      {list.icon
                        ? <ListIcon icon={list.icon} size={10} />
                        : <span className="size-1.5 rounded-full" style={{ backgroundColor: list.color ?? 'var(--accent)' }} aria-hidden="true" />}
                      <span className="truncate">{list.name}</span>
                    </span>
                  )}
                  {task.priority !== 'medium' && (
                    <span className="inline-flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      <span className={cn('size-1.5 rounded-full', priorityDot(task.priority))} aria-hidden="true" />
                      {priorityLabel(task.priority)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {rows.length === 0 && (
          <li className="px-1 py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            {t('todo.calendar.day_empty')}
          </li>
        )}
      </ul>
      <div className="mt-auto">
        <Button size="sm" block onClick={onAdd}>
          <CalendarPlus size={13} />{t('todo.calendar.add_on_day')}
        </Button>
      </div>
    </div>
  )
}

export function DayAgenda({ open, dayKey, tasks, lists, timezone, wide, onClose, onOpenTask, onToggle, onAdd }: {
  open: boolean
  /** The account-zone day the panel describes; null while it is closed. */
  dayKey: string | null
  tasks: readonly TodoTask[]
  lists: readonly TaskList[]
  timezone: string
  wide: boolean
  onClose: () => void
  onOpenTask: (task: TodoTask) => void
  onToggle: (task: TodoTask) => void
  onAdd: (dayKey: string) => void
}) {
  if (dayKey === null) return null
  const title = new Intl.DateTimeFormat(localeTag(), { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${dayKey}T00:00:00`))
  const count = tasksOfDay(tasks, dayKey, timezone).length
  const body = (
    <DayBody
      dayKey={dayKey}
      tasks={tasks}
      lists={lists}
      timezone={timezone}
      onOpenTask={onOpenTask}
      onToggle={onToggle}
      onAdd={() => onAdd(dayKey)}
    />
  )
  if (wide) {
    return (
      <Drawer open={open} onClose={onClose} side="right" width={380} title={title} ariaLabel={title}>
        <div className="flex flex-col gap-2 p-3">
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {t('todo.calendar.day_count', { count })}
          </p>
          {body}
        </div>
      </Drawer>
    )
  }
  return (
    <Modal open={open} onClose={onClose} title={title} width={520} ariaLabel={title}>
      <p className="mb-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t('todo.calendar.day_count', { count })}
      </p>
      {body}
    </Modal>
  )
}
