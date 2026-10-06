/**
 * Which property holds which day is decided once here: every surface that prints a date reads it
 * through these accessors, so an item cannot show one day on the board and another in the gallery.
 * `dueDate` is what the detail modal's due field writes, `endDate` is the generated schema's own
 * end column, and both are deadlines — a card carries at most one of them. Whether such a deadline
 * has been missed is decided here too, for the same reason: a badge that is late on one surface has
 * to be late on all of them.
 */
import { dateKey, daysBetweenKeys, formatDateKey } from '../../time'
import { isKanbanItemDone } from './item-status'
import type { KanbanItem, KanbanProperty } from './types'

function readDayKey(item: KanbanItem, propertyId: string): string {
  const value = item.properties[propertyId]
  return typeof value === 'string' ? value : ''
}

/**
 * A stored date value as the day it names, or `''` when it names none. A board authored elsewhere
 * may carry a time after the day, so the leading `YYYY-MM-DD` of an ISO timestamp still counts.
 */
export function kanbanDayKey(value: unknown): string {
  if (!value) return ''
  const match = String(value).trim().match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : ''
}

export function getKanbanStartDate(item: KanbanItem): string {
  return readDayKey(item, 'startDate')
}

export function getKanbanDueDate(item: KanbanItem): string {
  return readDayKey(item, 'dueDate') || readDayKey(item, 'endDate')
}

/** The day a card badge prints: its deadline, or the start when the card only has one. */
export function getKanbanCardDate(item: KanbanItem): string {
  return getKanbanDueDate(item) || getKanbanStartDate(item)
}

/**
 * Whole days between a missed day and `now`, or 0 when nothing was missed. Only a deadline can be
 * missed — a card that merely started long ago is not late — and finished work stops being late
 * about a date it already met.
 */
function overdueDaysFrom(item: KanbanItem, deadline: string, now: Date): number {
  if (!deadline || isKanbanItemDone(item)) return 0
  return Math.max(0, daysBetweenKeys(deadline, dateKey(now)))
}

export function getKanbanOverdueDays(item: KanbanItem, now = new Date()): number {
  return overdueDaysFrom(item, kanbanDayKey(getKanbanDueDate(item)), now)
}

/**
 * How late a card is according to one of its own date columns, which is the question a filter
 * asking "overdue" of a chosen column has to answer — a board may keep several dates per card.
 */
export function getKanbanPropertyOverdueDays(item: KanbanItem, propertyId: string, now = new Date()): number {
  return overdueDaysFrom(item, kanbanDayKey(readDayKey(item, propertyId)), now)
}

export interface KanbanCardDate {
  /** The day the badge carries, already in the reader's own date format. */
  dateText: string
  /** Whole days the deadline was missed by; 0 when the card is not late. */
  overdueDays: number
}

export function readKanbanCardDate(item: KanbanItem, now = new Date()): KanbanCardDate | null {
  const key = getKanbanCardDate(item)
  if (!key) return null
  return {
    dateText: formatDateKey(kanbanDayKey(key) || key, now),
    overdueDays: getKanbanOverdueDays(item, now),
  }
}

export interface KanbanDueNotice {
  /** The date column the notice counted and its filter button writes, so the two always agree. */
  propertyId: string
  /** Cards whose deadline day is before today, still open. */
  overdue: KanbanItem[]
  /** Cards whose deadline day is today, still open. */
  dueToday: KanbanItem[]
}

/**
 * The board's opening answer to "what is owed": the still-open cards past their day, and the ones
 * due today, read off one date column. The column is chosen once — the view's own date field, then
 * `dueDate`, then `endDate`, then the first date column that holds anything — because the notice's
 * numbers and the filter its button writes have to be the same question asked twice. Property
 * values outside a date column are invisible here on purpose: a deadline the board never declared
 * a column for has no filter to be written into, and a notice that could not be acted on would
 * only nag.
 */
export function kanbanDueNotice(
  items: KanbanItem[],
  columns: KanbanProperty[],
  dateFieldHint?: string,
  now: Date = new Date(),
): KanbanDueNotice | null {
  const dateColumns = columns.filter((column) => column.type === 'date')
  const hasValue = (propertyId: string) => items.some((item) => kanbanDayKey(readDayKey(item, propertyId)) !== '')
  const named = [dateFieldHint, 'dueDate', 'endDate']
    .filter((id): id is string => typeof id === 'string')
    .find((id) => dateColumns.some((column) => column.id === id) && hasValue(id))
    ?? dateColumns.find((column) => hasValue(column.id))?.id
  if (!named) return null
  const today = dateKey(now)
  const overdue: KanbanItem[] = []
  const dueToday: KanbanItem[] = []
  for (const item of items) {
    if (item.archived || item.deleted) continue
    const deadline = kanbanDayKey(readDayKey(item, named))
    if (!deadline || isKanbanItemDone(item)) continue
    if (deadline < today) overdue.push(item)
    else if (deadline === today) dueToday.push(item)
  }
  return { propertyId: named, overdue, dueToday }
}
