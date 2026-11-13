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
  ProjectPeople,
  ProjectProperty,
  ProjectSortOption,
} from './model'
import { isProjectFilterGroup, projectPersonLabel, PROJECT_TITLE_PROPERTY_ID } from './model'
import { parseProjectDateValue, projectStampToDay } from './date'

const HALF_DAY_MS = 12 * 60 * 60 * 1000

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

/** B-11: a new card inherits the value-pinning clauses (is / includes with one value) of the active filter. */
export function projectFilterPrefill(filter: ProjectFilterGroup | undefined): Record<string, string> {
  const values: Record<string, string> = {}
  const walk = (group: ProjectFilterGroup): void => {
    for (const entry of group.filters) {
      if (isProjectFilterGroup(entry)) walk(entry)
      else if ((entry.condition === 'is' || entry.condition === 'includes') && entry.values.length === 1) values[entry.propertyId] = entry.values[0]!
    }
  }
  if (filter) walk(filter)
  return values
}

/** Human-readable cell text shared by the table cells and the compact list rows. */
export function projectPropertyDisplayText(card: ProjectCard, property: ProjectProperty, people?: ProjectPeople, locale?: string): string {
  const raw = card.values[property.id] ?? ''
  switch (property.type) {
    case 'select': return raw ? projectOptionLabel(property, raw) : ''
    case 'multiSelect': return raw ? asArray(raw).map((id) => projectOptionLabel(property, id)).join(', ') : ''
    case 'person': return projectPersonLabel(people, raw)
    case 'multiPerson': return raw ? asArray(raw).map((id) => projectPersonLabel(people, id)).join(', ') : ''
    case 'checkbox': return raw === 'true' ? '✓' : ''
    case 'date': {
      const range = parseProjectDateValue(raw)
      if (range?.from === undefined) return ''
      const includeTime = range.includeTime === true
      const from = projectStampToDay(range.from, includeTime).toLocaleDateString(locale)
      return range.to !== undefined && range.to !== range.from ? `${from} – ${projectStampToDay(range.to, includeTime).toLocaleDateString(locale)}` : from
    }
    case 'createdBy': return projectPersonLabel(people, card.createdBy)
    case 'updatedBy': return projectPersonLabel(people, card.modifiedBy)
    case 'createdTime': return new Date(card.createAt).toLocaleDateString(locale)
    case 'updatedTime': return new Date(card.updateAt).toLocaleDateString(locale)
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
      const date = parseProjectDateValue(value)
      if (date && (property?.type === 'date' || stampType)) {
        const target = parseProjectDateValue(needles[0]!)
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
      const date = parseProjectDateValue(value)
      const target = parseProjectDateValue(needles[0]!)
      if (!date || date.from === undefined || !target || target.from === undefined) return false
      return stampType ? date.from < target.from - HALF_DAY_MS : date.from < target.from
    }
    case 'isAfter': {
      if (empty) return true
      const date = parseProjectDateValue(value)
      const target = parseProjectDateValue(needles[0]!)
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

/** Every key a grouped view has to draw: the property's own options plus whatever the cards hold. */
export function projectGroupKeys(
  cards: readonly ProjectCard[],
  groupById: string | undefined,
  properties: readonly ProjectProperty[],
): string[] {
  if (!groupById) return ['']
  const property = properties.find((entry) => entry.id === groupById)
  const keys = new Set<string>()
  if (property && (property.type === 'select' || property.type === 'multiSelect')) {
    for (const option of property.options) keys.add(option.id)
  }
  for (const key of groupProjectCards(cards, groupById, properties).keys()) keys.add(key)
  keys.add('')
  return [...keys]
}

/** A group key as a reader sees it, including people and dates that are not option ids. */
export function projectGroupLabel(
  property: ProjectProperty | undefined,
  key: string,
  people?: ProjectPeople,
  locale?: string,
): string {
  if (!property) return key
  switch (property.type) {
    case 'select':
    case 'multiSelect':
      return projectOptionLabel(property, key)
    case 'person':
    case 'multiPerson':
    case 'createdBy':
    case 'updatedBy':
      return projectPersonLabel(people, key)
    case 'date': {
      const range = parseProjectDateValue(key)
      if (range?.from === undefined) return key
      return projectStampToDay(range.from, range.includeTime === true).toLocaleDateString(locale)
    }
    default:
      return key
  }
}

/**
 * C-23: strip the leading emoji cluster before comparing, so "🗺️ Roadmap" sorts under R rather than
 * under the emoji's code point. The reference's `\p{Emoji}` also matches digits and leaves the
 * variation selector behind, which put "🗺️ Zebra" ahead of "Apple"; Extended_Pictographic plus the
 * joiner/modifier code points strips the whole cluster and leaves ordinary titles alone.
 */
export function sortProjectViewsAlphabetically<T extends { title: string }>(views: readonly T[]): T[] {
  return views
    .map((view) => ({ view, title: view.title.replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\s]+/u, '') }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((entry) => entry.view)
}

/**
 * C-12: the view's own search box, which the reference runs over the title and every property's
 * display text. Both sides are lowercased, matching this port's filter correction (Q-10).
 */
export function matchProjectViewSearch(
  card: ProjectCard,
  query: string,
  properties: readonly ProjectProperty[],
  people?: ProjectPeople,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  if (card.title.toLowerCase().includes(needle)) return true
  return properties.some((property) => projectPropertyDisplayText(card, property, people).toLowerCase().includes(needle))
}

/**
 * The manual order a reader dragged, laid over the sort the view computed.
 *
 * A card the order names sits where it was dropped; a card it does not name (a new one, or one that
 * arrived from another view) keeps its sorted place after them. An empty order is the sorted list
 * unchanged, so a board that has never been dragged behaves exactly as it did before.
 */
export function orderProjectCards(cards: readonly ProjectCard[], cardOrder: readonly string[]): ProjectCard[] {
  if (cardOrder.length === 0) return [...cards]
  const rank = new Map(cardOrder.map((id, index) => [id, index]))
  return [...cards].sort((left, right) => {
    const a = rank.get(left.id)
    const b = rank.get(right.id)
    if (a === undefined && b === undefined) return 0
    if (a === undefined) return 1
    if (b === undefined) return -1
    return a - b
  })
}

/**
 * Where a dropped card lands in the view's manual order.
 *
 * `index` counts the target column's cards with the dragged one already removed, so the anchor is
 * simply the card now at that position. Cards the view does not show keep their relative order at the
 * end: a filtered board must not reshuffle the cards it hid.
 */
export function projectKanbanDropOrder(input: {
  columns: readonly { key: string, cardIds: readonly string[] }[]
  cardOrder: readonly string[]
  draggedIds: readonly string[]
  target: { zone: string, index: number }
}): string[] {
  const { columns, cardOrder, draggedIds, target } = input
  const dragged = new Set(draggedIds)
  const column = columns.find((entry) => entry.key === target.zone)
  if (!column || dragged.size === 0) return [...cardOrder]
  const flat = columns.flatMap((entry) => entry.cardIds).filter((id) => !dragged.has(id))
  const landing = column.cardIds.filter((id) => !dragged.has(id))
  const anchor = landing[target.index]
  let at: number
  if (anchor !== undefined) at = flat.indexOf(anchor)
  else if (landing.length > 0) at = flat.indexOf(landing[landing.length - 1]!) + 1
  else {
    const before = columns.slice(0, columns.indexOf(column)).flatMap((entry) => entry.cardIds).filter((id) => !dragged.has(id))
    at = before.length
  }
  flat.splice(at, 0, ...draggedIds)
  const visible = new Set(flat)
  return [...flat, ...cardOrder.filter((id) => !visible.has(id))]
}