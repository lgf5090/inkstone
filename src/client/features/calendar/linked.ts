/**
 * The read-only reads the day panel makes into other modules.
 *
 * All three are reads through their own public HTTP surfaces, so nothing here knows a table name:
 * the calendar is allowed to say "these rows exist on this day", not to change them. A write that a
 * reader asks for from this panel is done by the owning module, through its own editor, after the
 * jump — which is also why every row carries the address it belongs to.
 */

import { request } from '../../lib/api'

export interface LinkedTodo {
  id: string
  title: string
  status: string
  /** Epoch milliseconds or an ISO instant, as the to-do API answers; null when the row has no date. */
  dueAt: number | string | null
}

export interface LinkedRenewal {
  id: string
  name: string
  amount: number | null
  currency: string
  expiryDate: string
  isActive: boolean
}

function instantOf(value: number | string | null): number | null {
  if (value === null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Tasks whose due date is that account day, read through the to-do listing's own range filter. */
export async function todosDueOn(day: string, signal?: AbortSignal): Promise<LinkedTodo[]> {
  const params = new URLSearchParams({
    dueFrom: `${day}T00:00`,
    dueTo: `${day}T23:59`,
    limit: '50',
  })
  const data = await request<{ tasks?: LinkedTodo[] }>(`/api/todos?${params.toString()}`, { signal })
  return (data.tasks ?? []).filter(task => instantOf(task.dueAt) !== null)
}

/**
 * Plans whose expiry date is that day.
 *
 * The subscription app has no range endpoint of its own, and inventing one would mean a second copy
 * of its derived rows; the bundle is read instead and filtered here. It is fetched only when a reader
 * opens the day panel, which is the one moment its cost buys something.
 */
export async function renewalsOn(day: string, signal?: AbortSignal): Promise<LinkedRenewal[]> {
  const data = await request<{ items?: LinkedRenewal[] }>('/api/subscriptions', { signal })
  return (data.items ?? []).filter(item => item.expiryDate.slice(0, 10) === day)
}
