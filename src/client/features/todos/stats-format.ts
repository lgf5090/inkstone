/**
 * The words the statistics screen and its CSV put beside a raw key.
 *
 * Priority, list, tag and weekday labels are needed by two readers — the on-screen bars and the
 * exported file — so they live here instead of being spelled twice and drifting in the second copy.
 * The weekday formatter is pinned to UTC because a midnight instant in a western zone is the day
 * before.
 */
import type { TaskPriority, TaskStatsNamedCount } from '@shared/todos/model'
import { localeTag, t, type MessageKey } from '../../lib/i18n'

/** The order priorities are listed in: the same low-to-urgent ladder the task form shows. */
export const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

const PRIORITY_LABELS: Record<TaskPriority, MessageKey> = {
  low: 'todo.priority.low',
  medium: 'todo.priority.medium',
  high: 'todo.priority.high',
  urgent: 'todo.priority.urgent',
}

export function priorityLabel(priority: TaskPriority): string {
  return t(PRIORITY_LABELS[priority])
}

/** A weekday name from the account-calendar index the server counts (0 = Sunday). */
export function weekdayName(weekday: number): string {
  // 2023-01-01 is a Sunday, so the index is the weekday the server counts.
  const date = new Date(Date.UTC(2023, 0, 1 + weekday))
  return new Intl.DateTimeFormat(localeTag(), { weekday: 'short', timeZone: 'UTC' }).format(date)
}

/** The name a list slice shows: its own name, the inbox's translated one, or "deleted list". */
export function listName(entry: TaskStatsNamedCount): string {
  return entry.name ?? (entry.id === null ? t('todo.smart.inbox') : t('todo.stats.unknown_list'))
}

/** The name a tag slice shows; a tag with a missing name is still a tag. */
export function tagName(entry: TaskStatsNamedCount): string {
  return entry.name ?? t('todo.view.tag')
}
