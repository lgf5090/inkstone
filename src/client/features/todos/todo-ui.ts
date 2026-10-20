/**
 * The small readings the to-do screens share: how a due date reads, how a priority looks, and the
 * words a repeat rule is described with.
 *
 * Kept out of the components because three of them need the same answer, and because a date that
 * reads one way on a card and another in the editor is the kind of difference a reader notices.
 */

import { localDate, toLocalMinute } from '@shared/assistant-time'
import type { TaskPriority, RepeatRule } from '@shared/todos/model'
import { getLocale, t } from '../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'

const PRIORITY_KEYS: Record<TaskPriority, MessageKey> = {
  low: 'todo.priority.low',
  medium: 'todo.priority.medium',
  high: 'todo.priority.high',
  urgent: 'todo.priority.urgent',
}

/** The class a priority dot is painted with. The label always rides along, so colour is never alone. */
const PRIORITY_DOTS: Record<TaskPriority, string> = {
  low: 'bg-[var(--text-quaternary)]',
  medium: 'bg-[var(--accent)]',
  high: 'bg-[var(--warning)]',
  urgent: 'bg-[var(--danger)]',
}

export function priorityLabel(priority: TaskPriority): string {
  return t(PRIORITY_KEYS[priority])
}

export function priorityDot(priority: TaskPriority): string {
  return PRIORITY_DOTS[priority]
}

/**
 * A due date as a card shows it: the time when it is today, the day otherwise.
 *
 * A date with no time is stored as the end of that day, so it is shown as a day and never as
 * "23:59" — the minute is an implementation detail of "due by then", not something the reader wrote.
 */
export function dueLabel(dueAt: number | null, bounds: { dayEnd: number; now: number }, timezone: string): { text: string; overdue: boolean } | null {
  if (dueAt === null) return null
  const locale = getLocale()
  const today = localDate(bounds.now, timezone)
  const day = localDate(dueAt, timezone)
  const minute = toLocalMinute(dueAt, timezone)
  const hasTime = !minute.endsWith('T23:59')
  const overdue = dueAt < bounds.now
  if (day === today) {
    if (!hasTime) return { text: t('todo.smart.today'), overdue }
    return { text: minute.slice(11), overdue }
  }
  const formatted = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(dueAt))
  return { text: formatted, overdue }
}

/** The words a repeat rule is described with, or null when the task does not repeat. */
export function repeatLabel(rule: RepeatRule | null): string | null {
  if (!rule) return null
  if (rule.interval <= 1) return t(`todo.repeat.${rule.freq}` as MessageKey)
  return t('todo.repeat.every', {
    count: rule.interval,
    unit: t(`todo.repeat.unit.${rule.freq}` as MessageKey),
  })
}

/** A due date as the date picker wants it: local wall time, or an empty string. */
export function dueValue(dueAt: number | null, timezone: string): string {
  if (dueAt === null) return ''
  const minute = toLocalMinute(dueAt, timezone)
  return minute.endsWith('T23:59') ? minute.slice(0, 10) : minute
}

/** The longest a freeform icon may be and still be one a reader picked — an emoji, not a word. */
const ICON_TEXT_MAX = 3

/**
 * The list icon a badge can actually draw, or null.
 *
 * The picker writes `lucide:<Name>` for the thirteen icons it offers and the emoji itself for the
 * rest, so those are the two shapes a list icon has. A bare word — which only the API can let in, since
 * nothing in the app writes one — is neither: the badge would draw its first three letters as text, and
 * "Bri" beside a list named Work reads as a typo rather than as a missing icon. Returning null lets the
 * caller draw its own default, which is the honest answer for a value this app cannot render.
 */
export function listIconFor(icon: string | null | undefined): string | null {
  if (!icon) return null
  if (icon.startsWith('lucide:')) return icon
  return [...icon].length <= ICON_TEXT_MAX ? icon : null
}
