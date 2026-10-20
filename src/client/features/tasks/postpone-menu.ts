/**
 * The rows a postpone button opens, and the write behind each one.
 *
 * Built where the task already is — a `tasks` block row holds the parsed line — and handed to the host
 * as plain menu items. Every row computes its target date once, when the menu is drawn, and writes that
 * exact day: the reader clicks the date they can see, not a rule the code re-reads later.
 *
 * The write is the edit form's write. A postponement is a one-field draft change, so it goes through
 * `editTaskInNote` with the same line-and-words anchor, which is what keeps a row drawn from a stale
 * result from overwriting a note somebody else has since changed.
 */
import { isSameDay } from '../../lib/time'
import { t } from '../../lib/i18n'
import { formatTaskDate } from '../../lib/tasks/date/date-tools'
import { getDateFieldToPostpone, postponeDate } from '../../lib/tasks/date/postpone'
import type { HappensDate, PostponeUnit } from '../../lib/tasks/date/postpone'
import { draftFromTask } from '../../lib/tasks/edit/task-editor'
import { editTaskInNote, taskSettings } from '../../lib/tasks/service'
import { useUi } from '../../store/ui'
import type { MenuItem } from '../../components/overlay'
import type { Task } from '../../lib/tasks/model/task'
import type { MessageKey } from '@shared/locales/en-US'
import { usePostponeMenu } from './postpone-store'

/** The words each date field is called by, wherever a postpone has to name the one it moved. */
const FIELD_KEYS: Record<HappensDate, MessageKey> = {
  dueDate: 'tasks.field_due',
  scheduledDate: 'tasks.field_scheduled',
  startDate: 'tasks.field_start',
}

/**
 * The offsets counted from the day the task already names.
 *
 * One day is the "tomorrow" row instead, which counts from today: an overdue task postponed by a day
 * from its own date is still overdue. Six days is as far as a list is worth scrolling, and a month is
 * the one longer step a reader plans around.
 */
const OFFSETS: Array<{ unit: PostponeUnit; amount: number; key: MessageKey; count?: number }> = [
  { unit: 'day', amount: 2, key: 'tasks.postpone_days', count: 2 },
  { unit: 'day', amount: 3, key: 'tasks.postpone_days', count: 3 },
  { unit: 'day', amount: 4, key: 'tasks.postpone_days', count: 4 },
  { unit: 'day', amount: 5, key: 'tasks.postpone_days', count: 5 },
  { unit: 'day', amount: 6, key: 'tasks.postpone_days', count: 6 },
  { unit: 'week', amount: 1, key: 'tasks.postpone_week' },
  { unit: 'week', amount: 2, key: 'tasks.postpone_weeks', count: 2 },
  { unit: 'week', amount: 3, key: 'tasks.postpone_weeks', count: 3 },
  { unit: 'month', amount: 1, key: 'tasks.postpone_month' },
]

/** Open the menu for one task, anchored at the point the row passed. */
export function openPostponeMenu(task: Task, anchor: { x: number; y: number }): void {
  const field = getDateFieldToPostpone(task.fields)
  if (field === null) return
  const now = new Date()
  const current = task.fields[field]
  const fieldName = t(FIELD_KEYS[field])
  const items: MenuItem[] = [{ id: 'field', label: t('tasks.postpone_for_field', { value0: fieldName }), disabled: true }]

  const add = (id: string, phrase: string, target: Date | null, separator = false): void => {
    items.push({
      id,
      label: target === null ? phrase : `${phrase} · ${formatTaskDate(target)}`,
      checked: target !== null && current !== null && isSameDay(target, current),
      separatorBefore: separator,
      onSelect: () => void writePostponed(task, field, target),
    })
  }

  add('today', t('tasks.postpone_today'), postponeDate(task.fields, field, 0, 'day', 'from-today', now))
  add('tomorrow', t('tasks.postpone_tomorrow'), postponeDate(task.fields, field, 1, 'day', 'from-today', now))
  for (const [index, step] of OFFSETS.entries()) {
    const target = postponeDate(task.fields, field, step.amount, step.unit, 'from-date', now)
    add(step.unit + step.amount, t(step.key, step.count === undefined ? undefined : { value0: step.count }), target, index === 0)
  }

  // A scheduled date the note's own name supplies is not in the line, so there is nothing to take out of
  // it: the row says why rather than silently offering a click that cannot land.
  if (field === 'scheduledDate' && task.scheduledDateIsInferred) {
    items.push({ id: 'remove', label: t('tasks.postpone_remove_blocked'), disabled: true, separatorBefore: true })
  } else {
    add('remove', t('tasks.postpone_remove'), null, true)
  }

  usePostponeMenu.getState().open({ x: anchor.x, y: anchor.y, items })
}

async function writePostponed(task: Task, field: HappensDate, target: Date | null): Promise<void> {
  const draft = draftFromTask(task, taskSettings().globalFilter)
  draft.dates[field] = target === null ? '' : formatTaskDate(target)
  const result = await editTaskInNote(
    task.location.noteId,
    task.location.lineNumber,
    task.fields.description,
    { draft, statusSymbol: task.status.symbol },
  )
  if (result !== 'written') {
    useUi.getState().toast({
      title: t(result === 'conflict' ? 'dataview.task_moved' : 'dataview.task_unavailable'),
      tone: 'warning',
    })
    return
  }
  const fieldName = t(FIELD_KEYS[field])
  useUi.getState().toast({
    title: target === null
      ? t('tasks.postpone_removed', { value0: fieldName })
      : t('tasks.postpone_changed', { value0: fieldName, value1: formatTaskDate(target) }),
  })
}
