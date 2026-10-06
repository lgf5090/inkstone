import { getKanbanPropertyOverdueDays, kanbanDayKey } from './date-fields'
import type {
  KanbanColorName,
  KanbanFilter,
  KanbanFilterOperator,
  KanbanItem,
  KanbanProperty,
  KanbanPropertyType,
  KanbanSort,
} from './types'

/**
 * What the caller knows besides the cards: the schema, so a rule can be read as a question about
 * that kind of column, and the clock, so a missed deadline is decidable without a test having to
 * move time. Both are optional — a board read without a schema asks text questions, as it did.
 */
export interface KanbanFilterContext {
  columns?: KanbanProperty[]
  now?: Date
}

/**
 * The bucket a card with no value on the grouping axis lands in. The key is written here because this
 * is where the bucket is made; the drop writer and the move-to menu read the same key to mean "clear
 * this property", so introducing a second spelling would be introducing a second meaning.
 */
export const KANBAN_UNASSIGNED_KEY = '__none__'

/** What a rule may ask of a column, decided by the kind of value that column holds. */
const TEXT_OPERATORS: KanbanFilterOperator[] = [
  'contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty',
]
const CHOICE_OPERATORS: KanbanFilterOperator[] = ['equals', 'not_equals', 'is_empty', 'is_not_empty']
const NUMBER_OPERATORS: KanbanFilterOperator[] = [
  'equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal',
  'is_empty', 'is_not_empty',
]
// A date column's most useful question is the one its readers ask first: is anything still owed.
const DATE_OPERATORS: KanbanFilterOperator[] = [
  'is_not_empty', 'is_empty', 'before', 'after', 'equals', 'not_equals', 'is_overdue',
]

export function kanbanFilterOperatorsForType(type: KanbanPropertyType): KanbanFilterOperator[] {
  switch (type) {
    case 'number':
      return NUMBER_OPERATORS
    case 'date':
      return DATE_OPERATORS
    case 'select':
    case 'multi-select':
    case 'checkbox':
      return CHOICE_OPERATORS
    case 'files':
      return ['is_empty', 'is_not_empty']
    default:
      return TEXT_OPERATORS
  }
}

function isValueEmpty(val: unknown): boolean {
  if (val === null || val === undefined || val === '') return true
  if (Array.isArray(val) && val.length === 0) return true
  return false
}

function tagMatch(item: KanbanItem, value: string): boolean {
  const itemTags = Array.isArray(item.properties.tags) ? (item.properties.tags as string[]) : []
  const needle = value.toLowerCase()
  return itemTags.some((t) => t.toLowerCase() === needle)
    || Boolean(item.subtasks?.some((st) => st.tags?.some((t) => t.toLowerCase() === needle)))
}

function asNumber(val: unknown): number | null {
  if (val === '' || val === null || val === undefined || Array.isArray(val)) return null
  const parsed = Number(val)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The total of one number column over the cards given — the figure a column header shows when the
 * view sums by that column. Values arrive as numbers from the editors but a hand-written fence may
 * store numeric strings, and both count; blanks and anything else that is not a number count as
 * nothing rather than as zero cards' worth of noise.
 */
export function sumKanbanNumberProperty(items: KanbanItem[], propertyId: string): number {
  let total = 0
  for (const item of items) {
    const value = asNumber(item.properties[propertyId])
    if (value !== null) total += value
  }
  return total
}

function compareNumbers(itemVal: unknown, value: string, operator: KanbanFilterOperator): boolean {
  const threshold = asNumber(value)
  const subject = asNumber(itemVal)
  if (threshold === null || subject === null) return false
  if (operator === 'greater_than') return subject > threshold
  if (operator === 'less_than') return subject < threshold
  if (operator === 'greater_or_equal') return subject >= threshold
  return subject <= threshold
}

// Two days are their `YYYY-MM-DD` keys, which already order the way they read.
function compareDays(itemKey: string, value: string, operator: KanbanFilterOperator): boolean {
  const threshold = kanbanDayKey(value)
  if (!itemKey || !threshold) return false
  if (operator === 'before') return itemKey < threshold
  if (operator === 'after') return itemKey > threshold
  const same = itemKey === threshold
  return operator === 'equals' ? same : !same
}

// A choice may be stored as the option's id or, in a board imported from elsewhere, as its label.
function choiceMatches(itemVal: unknown, value: string, column?: KanbanProperty): boolean {
  const needle = value.trim().toLowerCase()
  const labels = new Map((column?.options ?? []).map((opt) => [opt.id.toLowerCase(), opt.label.toLowerCase()]))
  const oneWay = (stored: unknown) => {
    const key = String(stored ?? '').trim().toLowerCase()
    return key === needle || labels.get(key) === needle || labels.get(needle) === key
  }
  return Array.isArray(itemVal) ? itemVal.some(oneWay) : oneWay(itemVal)
}

function textOf(itemVal: unknown): string {
  return String(itemVal ?? '').toLowerCase()
}

function matchesFilter(item: KanbanItem, filter: KanbanFilter, context: KanbanFilterContext): boolean {
  const { propertyId, operator, value = '' } = filter
  const column = context.columns?.find((c) => c.id === propertyId)
  const itemVal = propertyId === 'title' ? item.title : item.properties[propertyId]

  // A number or date column is blank when it holds nothing of that kind, so "no points set" and
  // "points set to 'n/a'" are the same answer here as they are to a comparison on the same column.
  const readable = column?.type === 'number'
    ? asNumber(itemVal) !== null
    : column?.type === 'date'
      ? kanbanDayKey(itemVal) !== ''
      : !isValueEmpty(itemVal)
  if (operator === 'is_empty') return !readable
  if (operator === 'is_not_empty') return readable
  if (operator === 'is_overdue') {
    return column?.type === 'date' && getKanbanPropertyOverdueDays(item, propertyId, context.now) > 0
  }
  if (operator === 'greater_than' || operator === 'less_than'
    || operator === 'greater_or_equal' || operator === 'less_or_equal') {
    return compareNumbers(itemVal, value, operator)
  }
  // before/after only ever compare days, so they read whatever day the cell spells and nothing else;
  // equals reads a day only where the column's own kind is a date, or plain text columns lose the
  // exact match they had.
  if (operator === 'before' || operator === 'after') return compareDays(kanbanDayKey(itemVal), value, operator)
  if (column?.type === 'date' && (operator === 'equals' || operator === 'not_equals')) {
    return compareDays(kanbanDayKey(itemVal), value, operator)
  }
  if (operator === 'contains') return textOf(itemVal).includes(value.toLowerCase())
  if (operator === 'not_contains') return !textOf(itemVal).includes(value.toLowerCase())

  if (operator !== 'equals' && operator !== 'not_equals') {
    // A rule whose operator this version cannot read must not quietly hide cards: an author may have
    // written it by hand or imported it, and the only safe answer is the one that shows everything.
    return true
  }
  const same = propertyId === 'tags'
    ? tagMatch(item, value)
    : column?.options
      ? choiceMatches(itemVal, value, column)
      : Array.isArray(itemVal)
        ? itemVal.some((each) => choiceMatches(each, value))
        : textOf(itemVal) === value.trim().toLowerCase()
  return operator === 'not_equals' ? !same : same
}

export function applyKanbanFilters(
  items: KanbanItem[],
  filters?: KanbanFilter[],
  context: KanbanFilterContext = {},
): KanbanItem[] {
  if (!filters || filters.length === 0) return items
  return items.filter((item) => filters.every((filter) => matchesFilter(item, filter, context)))
}

// A date column orders by the day it names, not by how the card spelled it: a stored time is that
// same day and would otherwise sort after every bare date of it. No readable day sorts last either
// way, and a tie hands the decision to the next rule.
function compareDaySortKeys(aKey: string, bKey: string, direction: KanbanSort['direction']): number {
  if (!aKey && !bKey) return 0
  if (!aKey) return 1
  if (!bKey) return -1
  if (aKey === bKey) return 0
  const ascending = aKey < bKey ? -1 : 1
  return direction === 'asc' ? ascending : -ascending
}

function compareValueSort(aVal: unknown, bVal: unknown, direction: KanbanSort['direction']): number {
  if (aVal === bVal) return 0
  if (aVal === undefined || aVal === null) return 1
  if (bVal === undefined || bVal === null) return -1
  return String(aVal).localeCompare(String(bVal), undefined, { numeric: true }) * (direction === 'asc' ? 1 : -1)
}

export function applyKanbanSorts(
  items: KanbanItem[],
  sorts?: KanbanSort[],
  context: { columns?: KanbanProperty[] } = {},
): KanbanItem[] {
  if (!sorts || sorts.length === 0) return items
  return [...items].sort((a, b) => {
    for (const sort of sorts) {
      const column = context.columns?.find((c) => c.id === sort.propertyId)
      const aVal = sort.propertyId === 'title' ? a.title : a.properties[sort.propertyId]
      const bVal = sort.propertyId === 'title' ? b.title : b.properties[sort.propertyId]
      const cmp = column?.type === 'date'
        ? compareDaySortKeys(kanbanDayKey(aVal), kanbanDayKey(bVal), sort.direction)
        : compareValueSort(aVal, bVal, sort.direction)
      if (cmp !== 0) return cmp
    }
    return 0
  })
}

// A header click sorts by that column alone, so it replaces the rules the sort
// popover wrote; the popover and undo history remain the way back to them.
export function toggleKanbanColumnSort(sorts: KanbanSort[] | undefined, propertyId: string): KanbanSort[] {
  const current = (sorts ?? []).find((sort) => sort.propertyId === propertyId)
  if (!current) return [{ propertyId, direction: 'asc' }]
  if (current.direction === 'asc') return [{ propertyId, direction: 'desc' }]
  return []
}

export function toggleKanbanHiddenColumn(hidden: string[] | undefined, propertyId: string): string[] {
  const current = hidden ?? []
  return current.includes(propertyId) ? current.filter((id) => id !== propertyId) : [...current, propertyId]
}

function itemMatchesQuery(item: KanbanItem, q: string): boolean {
  if (item.title.toLowerCase().includes(q)) return true
  if (item.description?.toLowerCase().includes(q)) return true
  if (item.content?.toLowerCase().includes(q)) return true
  for (const val of Object.values(item.properties)) {
    if (typeof val === 'string' && val.toLowerCase().includes(q)) return true
    if (Array.isArray(val) && val.some((v) => String(v).toLowerCase().includes(q))) return true
  }
  if (item.subtasks?.some((st) =>
    st.title.toLowerCase().includes(q) ||
    (st.description && st.description.toLowerCase().includes(q)) ||
    (st.tags && st.tags.some((t) => t.toLowerCase().includes(q))),
  )) {
    return true
  }
  return false
}

export function searchKanbanItems(items: KanbanItem[], query: string): KanbanItem[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return items
  return items.filter((item) => itemMatchesQuery(item, trimmed))
}

export interface KanbanGroup {
  groupKey: string
  label: string
  color?: KanbanColorName
  items: KanbanItem[]
  /** How many cards the reader allows here; absent means no rule was written. */
  wipLimit?: number
}

/**
 * A limit is a count of cards, so anything else — text from a hand-written fence, zero, a fraction —
 * reads as no rule rather than as one that rejects every card on the column.
 */
export function normalizeKanbanWipLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** How far past the limit a column of `count` cards is; filling it exactly is not yet over. */
export function kanbanWipOver(count: number, limit: number | undefined): number {
  if (limit === undefined) return 0
  return Math.max(0, count - limit)
}

// Documents imported from other tools may store the option label where this
// board expects the option id; matching only by id would hide all of those
// cards in No Status, so fall back to a case-insensitive label match.
function findGroupForValue(groups: KanbanGroup[], val: unknown): KanbanGroup | undefined {
  const byId = groups.find((g) => g.groupKey === val)
  if (byId) return byId
  if (typeof val !== 'string') return undefined
  const needle = val.toLowerCase()
  return groups.find((g) => g.label.toLowerCase() === needle)
}

export function groupKanbanItems(
  items: KanbanItem[],
  groupPropertyId: string,
  groupProperty?: KanbanProperty,
): KanbanGroup[] {
  const groups: KanbanGroup[] = []
  const options = groupProperty?.options ?? []

  for (const opt of options) {
    groups.push({
      groupKey: opt.id,
      label: opt.label,
      color: opt.color,
      wipLimit: normalizeKanbanWipLimit(opt.wipLimit),
      items: [],
    })
  }

  const noGroupKey = KANBAN_UNASSIGNED_KEY
  const noGroup: KanbanGroup = {
    groupKey: noGroupKey,
    label: 'No Status',
    color: 'gray',
    items: [],
  }

  for (const item of items) {
    const val = item.properties[groupPropertyId]
    const matched = findGroupForValue(groups, val)
    if (matched) {
      matched.items.push(item)
    } else {
      noGroup.items.push(item)
    }
  }

  if (noGroup.items.length > 0 || groups.length === 0) {
    groups.unshift(noGroup)
  }

  return groups
}
