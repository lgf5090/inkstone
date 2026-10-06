/**
 * Whether a card has reached its final state. A board imported from another tool may store either
 * the option id or the option label in `status`, so both spellings of the finished group count.
 * Lives apart from the date accessors because both the completion metrics and the overdue rule
 * need it, and the date module must stay importable by the filter module.
 */
import type { KanbanItem } from './types'

const DONE_VALUES = new Set(['done', 'complete', 'completed'])

export function isKanbanItemDone(item: KanbanItem): boolean {
  const status = item.properties.status
  if (typeof status !== 'string') return false
  return DONE_VALUES.has(status.trim().toLowerCase().replace(/[\s_-]+/g, ''))
}
