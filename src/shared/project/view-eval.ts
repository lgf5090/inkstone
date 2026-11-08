/**
 * Evaluating a view over a board's cards: filter, sort, group. These are pure so the client can
 * re-run them on every keystroke and the tests can pin the reference's exact truth table (§6.4),
 * including the one place this port deliberately differs: text comparisons lowercase BOTH sides
 * (the reference only lowercased the filter value, so `contains "ABC"` never matched `ABC`).
 */
import type {
  ProjectCard,
  ProjectFilterClause,
  ProjectFilterGroup,
  ProjectProperty,
  ProjectSortOption,
} from './model'
import { isProjectFilterGroup, PROJECT_TITLE_PROPERTY_ID } from './model'

const HALF_DAY_MS = 12 * 60 * 60 * 1000

interface DateValue {
  from?: number
  to?: number
}

/** The reference stores a date as an object or a bare millisecond string; readers take both. */
function parseDateValue(raw: string): DateValue | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as { from?: unknown, to?: unknown }
        const from = typeof record.from === 'number' ? record.from : undefined
        const to = typeof record.to === 'number' ? record.to : undefined
        if (from === undefined && to === undefined) return null
        return { from, to }
      }
      return null
    } catch {
      return null
    }
  }
  const stamp = Number(trimmed)
  return Number.isFinite(stamp) ? { from: stamp } : null
}

/** The value a clause compares against, with the server-stamped fallbacks the reference uses. */
export function projectCardDisplayValue(
  card: ProjectCard,
  propertyId: string,
  properties: readonly ProjectProperty[],
): string {
  if (propertyId === PROJECT_TITLE_PROPERTY_ID || propertyId === 'title') return card.title
  const property = properties.find((entry) => entry.id === propertyId)
  const raw = card.values[propertyId] ?? ''
  if (raw) return raw
  switch (property?.type) {
    case 'createdBy': return card.createdBy
    case 'updatedBy': return card.modifiedBy
    case 'createdTime': return String(card.createAt)
    case 'updatedTime': return String(card.updateAt)
    default: return raw
  }
}

function asArray(value: string): string[] {
  if (value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // fall through to scalar
    }
  }
  return [value]
}

export function projectOptionLabel(property: ProjectProperty, id: string): string {
  return property.options.find((option) => option.id === id)?.value ?? id
}

/** Human-readable cell text shared by the table cells and the compact list rows. */
export function projectPropertyDisplayText(card: ProjectCard, property: ProjectProperty): string {
  const raw = card.values[property.id] ?? ''
  switch (property.type) {
    case 'select': return raw ? projectOptionLabel(property, raw) : ''
    case 'multiSelect': return raw ? asArray(raw).map((id) => projectOptionLabel(property, id)).join(', ') : ''
    case 'checkbox': return raw === 'true' ? '✓' : ''
    case 'date': {
      const range = parseDateValue(raw)
      if (range?.from === undefined) return ''
      const from = new Date(range.from).toLocaleDateString()
      return range.to !== undefined && range.to !== range.from ? `${from} – ${new Date(range.to).toLocaleDateString()}` : from
    }
    case 'createdBy': return card.createdBy
    case 'updatedBy': return card.modifiedBy
    case 'createdTime': return new Date(card.createAt).toLocaleDateString()
    case 'updatedTime': return new Date(card.updateAt).toLocaleDateString()
    default: return raw
  }
}

function matchClause(card: ProjectCard, clause: ProjectFilterClause, properties: readonly ProjectProperty[]): boolean {
  const property = properties.find((entry) => entry.id === clause.propertyId)
  const isTitle = clause.propertyId === PROJECT_TITLE_PROPERTY_ID || clause.propertyId === 'title'
  const raw = projectCardDisplayValue(card, clause.propertyId, properties)
  const value = isTitle ? raw.toLowerCase() : raw
  const needles = clause.values.map((entry) => entry.toLowerCase())
  const empty = needles.length === 0
  const stampType = property?.type === 'createdTime' || property?.type === 'updatedTime'

  switch (clause.condition) {
    case 'includes':
      if (empty) return true
      return asArray(value).some((part) => needles.includes(part.toLowerCase()))
    case 'notIncludes':
      if (empty) return true
      return !asArray(value).some((part) => needles.includes(part.toLowerCase()))
    case 'isEmpty': return (value || '').length <= 0
    case 'isNotEmpty': return (value || '').length > 0
    case 'isSet': return Boolean(value)
    case 'isNotSet': return !value
    case 'is': {
      if (empty) return true
      const date = parseDateValue(value)
      if (date && (property?.type === 'date' || stampType)) {
        const target = parseDateValue(needles[0]!)
        if (!target || target.from === undefined) return false
        const f = target.from
        if (stampType) return date.from !== undefined && date.from > f - HALF_DAY_MS && date.from < f + HALF_DAY_MS
        if (date.from !== undefined && date.to !== undefined) return date.from <= f && date.to >= f
        return date.from === f
      }
      return needles[0] === value.toLowerCase()
    }
    case 'contains': return empty || value.toLowerCase().includes(needles[0]!)
    case 'notContains': return empty || !value.toLowerCase().includes(needles[0]!)
    case 'startsWith': return empty || value.toLowerCase().startsWith(needles[0]!)
    case 'notStartsWith': return empty || !value.toLowerCase().startsWith(needles[0]!)
    case 'endsWith': return empty || value.toLowerCase().endsWith(needles[0]!)
    case 'notEndsWith': return empty || !value.toLowerCase().endsWith(needles[0]!)
    case 'isBefore': {
      if (empty) return true
      const date = parseDateValue(value)
      const target = parseDateValue(needles[0]!)
      if (!date || date.from === undefined || !target || target.from === undefined) return false
      return stampType ? date.from < target.from - HALF_DAY_MS : date.from < target.from
    }
    case 'isAfter': {
      if (empty) return true
      const date = parseDateValue(value)
      const target = parseDateValue(needles[0]!)
      if (!date || !target || target.from === undefined) return false
      if (stampType) return date.from !== undefined && date.from > target.from + HALF_DAY_MS
      const edge = date.to ?? date.from
      return edge !== undefined && edge > target.from
    }
    case 'greaterThan': {
      if (empty) return true
      const a = Number(value)
      const b = Number(clause.values[0])
      return Number.isFinite(a) && Number.isFinite(b) && a > b
    }
    case 'lessThan': {
      if (empty) return true
      const a = Number(value)
      const b = Number(clause.values[0])
      return Number.isFinite(a) && Number.isFinite(b) && a < b
    }
    default: return true
  }
}

export function matchProjectFilterGroup(
  card: ProjectCard,
  group: ProjectFilterGroup,
  properties: readonly ProjectProperty[],
): boolean {
  if (group.filters.length === 0) return true
  const results = group.filters.map((entry) =>
    isProjectFilterGroup(entry)
      ? matchProjectFilterGroup(card, entry, properties)
      : matchClause(card, entry, properties),
  )
  return group.operation === 'and' ? results.every(Boolean) : results.some(Boolean)
}

function compareValues(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b)
}

/** Multi-key sort; an empty value sorts last regardless of direction, as the reference does. */
export function sortProjectCards(
  cards: readonly ProjectCard[],
  sortOptions: readonly ProjectSortOption[],
  properties: readonly ProjectProperty[],
): ProjectCard[] {
  if (sortOptions.length === 0) return [...cards]
  return [...cards].sort((a, b) => {
    for (const option of sortOptions) {
      const av = projectCardDisplayValue(a, option.propertyId, properties)
      const bv = projectCardDisplayValue(b, option.propertyId, properties)
      if (av === bv) continue
      if (av === '') return 1
      if (bv === '') return -1
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return option.reversed ? -cmp : cmp
    }
    return 0
  })
}

/** Group cards by one property's value; the empty key collects cards with no value. */
export function groupProjectCards(
  cards: readonly ProjectCard[],
  groupById: string | undefined,
  properties: readonly ProjectProperty[],
): Map<string, ProjectCard[]> {
  const groups = new Map<string, ProjectCard[]>()
  if (!groupById) {
    groups.set('', [...cards])
    return groups
  }
  for (const card of cards) {
    const raw = projectCardDisplayValue(card, groupById, properties)
    const keys = raw ? asArray(raw) : ['']
    for (const key of keys) {
      const bucket = groups.get(key)
      if (bucket) bucket.push(card)
      else groups.set(key, [card])
    }
  }
  return groups
}