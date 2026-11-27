/**
 * The read-only reads the day panel makes into other modules.
 *
 * All three are reads through their own public HTTP surfaces, so nothing here knows a table name:
 * the calendar is allowed to say "these rows exist on this day", not to change them. A write that a
 * reader asks for from this panel is done by the owning module, through its own editor, after the
 * jump — which is also why every row carries the address it belongs to.
 */

import { Temporal } from 'temporal-polyfill'
import type { SubscriptionExpiry } from '@shared/subscriptions/model'
import { api } from '../../lib/api'

export interface LinkedTodo {
  id: string
  title: string
  status: string
  /** Epoch milliseconds or an ISO instant, as the to-do API answers; null when the row has no date. */
  dueAt: number | string | null
}

export type LinkedRenewal = SubscriptionExpiry

function instantOf(value: number | string | null): number | null {
  if (value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Tasks whose due date is that account day, read through the to-do listing's own range filter. */
export async function todosDueOn(day: string, signal?: AbortSignal): Promise<LinkedTodo[]> {
  const next = Temporal.PlainDate.from(day).add({ days: 1 }).toString()
  const pageSize = 500
  const tasks: LinkedTodo[] = []
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  while (offset < total) {
    const params = {
      dueFrom: `${day}T00:00`,
      dueTo: `${next}T00:00`,
      sort: 'due',
      limit: pageSize,
      offset,
    }
    const data = await api.todos.list(params, signal)
    const rows = data.tasks ?? []
    const page = rows.filter(task => instantOf(task.dueAt) !== null)
    total = data.total
    if (rows.length === 0 && offset < total) throw new Error('The task page ended before its total')
    tasks.push(...page)
    offset += rows.length
  }
  return tasks
}

/** Plans whose expiry falls on that account day, read through the indexed expiry endpoint. */
export async function renewalsOn(day: string, signal?: AbortSignal): Promise<LinkedRenewal[]> {
  const items: LinkedRenewal[] = []
  let cursor: string | undefined
  do {
    const page = await api.subscriptions.expiring(day, 500, cursor, signal)
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}
