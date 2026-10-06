/**
 * Which of a board's own columns a card prints beneath its title.
 *
 * A card used to draw a fixed set — tags, a description excerpt, subtasks, a deadline, a priority and
 * an attachment count — and nothing else, so a column a reader had added (an environment, an estimate)
 * was reachable only by opening the card or switching to the table. The gap is not that the board
 * cannot *show* such a value but that it was never asked to: the value is in the document, and the
 * card simply had no way to be told about it (the review of 2026-09-23 recorded the board's own
 * values as incomplete for exactly this reason).
 *
 * A view therefore carries `cardFields`: the columns it wants printed on its cards, in the order they
 * are read. Absent means none — every existing board keeps the card it had, and the ordered list is
 * what tells the card which values to put beside its title and in which order. Configuring the *fixed*
 * regions (turning the subtask list or the tags row off) is deliberately not part of this: those are
 * what the card has always drawn, and removing them changes every board that never asked.
 *
 * The value of a field is read here rather than at each surface, so a card, a future gallery card and
 * a list row cannot disagree about what an option, a day or a person reads as — the same rule the
 * date badge follows for the card's own deadline.
 */
import { formatDateKey } from '../../time'
import { kanbanDayKey } from './date-fields'
import { formatKanbanOptionLabel, formatKanbanPropertyName } from './i18n-helpers'
import { kanbanPersonName } from './person'
import { safeKanbanUrl } from './url'
import type { KanbanItem, KanbanProperty, KanbanView } from './types'

/** Unset views share this list so a memoised card keeps one identity across unrelated renders. */
export const EMPTY_KANBAN_CARD_FIELDS: string[] = []

/**
 * Several values of one column, joined the way this module already joins them: the table cell that
 * prints the same list uses a comma, and a card that read differently from the cell beside it would be
 * the second convention here for one job.
 */
function joinValues(values: string[]): string {
  return values.join(', ')
}

/**
 * Adds a column to a view's card fields or takes it away, keeping the order they were picked in — the
 * card reads the list left to right, so a new field appends rather than sorting itself in.
 */
export function toggleKanbanCardField(fields: string[] | undefined, propertyId: string): string[] {
  const current = fields ?? EMPTY_KANBAN_CARD_FIELDS
  return current.includes(propertyId)
    ? current.filter((id) => id !== propertyId)
    : [...current, propertyId]
}

/**
 * The fields this view's cards print: the list a reader picked, minus every column the board no
 * longer has. A view outlives the columns it names — a column can be deleted, or renamed onto another
 * kind — so a stale id is dropped here, once, rather than guessed at by each surface that draws a card.
 */
export function kanbanCardFields(view: KanbanView, columns: KanbanProperty[]): string[] {
  const stored = view.cardFields
  if (!stored || stored.length === 0) return EMPTY_KANBAN_CARD_FIELDS
  const known = new Set(columns.map((column) => column.id))
  return stored.filter((id) => known.has(id))
}

/** The columns the panel offers, in schema order: every one that carries a value of its own. */
export function kanbanCardFieldOptions(columns: KanbanProperty[]): KanbanProperty[] {
  return columns.filter((column) => column.type !== 'title')
}

export interface KanbanCardField {
  /** The column it came from, which is what a list of them is keyed by — names are not unique. */
  id: string
  label: string
  value: string
  /**
   * Where the value goes when it is a link (`url` columns): present only when the stored text
   * passes the same URL whitelist the fence was read under, so a card never prints a link the
   * parse boundary would have refused.
   */
  href?: string
}

/**
 * A url prints as the link it names, but only through the fence's own whitelist: a value that would
 * not have survived the parse boundary prints as plain text instead of as a link.
 */
function readUrlField(column: KanbanProperty, raw: unknown): KanbanCardField | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return null
  const href = safeKanbanUrl(text) ?? undefined
  const field: KanbanCardField = { id: column.id, label: formatKanbanPropertyName(column), value: text }
  return href === undefined ? field : { ...field, href }
}

/**
 * One field as the card prints it — the column's own name and its value as text — or null when the
 * card has nothing to say about that column. A field with a label and no value prints as the label
 * alone, which is how a flag reads ("Done" rather than "Done: false").
 */
export function readKanbanCardField(item: KanbanItem, column: KanbanProperty): KanbanCardField | null {
  const label = formatKanbanPropertyName(column)
  const raw = item.properties[column.id]
  const field = (value: string, href?: string): KanbanCardField => (href === undefined ? { id: column.id, label, value } : { id: column.id, label, value, href })
  switch (column.type) {
    case 'checkbox':
      return raw === true ? field('') : null
    case 'select': {
      const option = column.options?.find((entry) => entry.id === raw || entry.label === raw)
      if (option) return field(formatKanbanOptionLabel(option, column.id))
      const text = typeof raw === 'string' ? raw.trim() : ''
      return text === '' ? null : field(text)
    }
    case 'multi-select': {
      const names = (Array.isArray(raw) ? raw : [])
        .map((value) => {
          const option = column.options?.find((entry) => entry.id === value || entry.label === value)
          if (option) return formatKanbanOptionLabel(option, column.id)
          return typeof value === 'string' ? value.trim() : ''
        })
        .filter((name) => name !== '')
      return names.length === 0 ? null : field(joinValues(names))
    }
    case 'date': {
      const day = kanbanDayKey(raw)
      return day === '' ? null : field(formatDateKey(day))
    }
    case 'person': {
      const name = kanbanPersonName(raw)
      return name === '' ? null : field(name)
    }
    case 'url':
      return readUrlField(column, raw)
    default: {
      // Text and number print as written. An object or a boolean is not a value this row knows
      // how to say, and printing `[object Object]` on a card is worse than printing nothing.
      if (raw === null || raw === undefined || raw === '') return null
      if (Array.isArray(raw)) {
        const printed = raw.map((value) => String(value)).filter((value) => value !== '')
        return printed.length === 0 ? null : field(joinValues(printed))
      }
      if (typeof raw === 'object' || typeof raw === 'boolean') return null
      return field(String(raw))
    }
  }
}

/** Every field of one item the view asks for, in the view's own order, with the empty ones dropped. */
export function readKanbanCardFields(
  item: KanbanItem,
  fields: string[],
  columns: KanbanProperty[],
): KanbanCardField[] {
  const byId = new Map(columns.map((column) => [column.id, column]))
  const read: KanbanCardField[] = []
  for (const id of fields) {
    const column = byId.get(id)
    if (!column) continue
    const field = readKanbanCardField(item, column)
    if (field) read.push(field)
  }
  return read
}

/**
 * The picture a card is known by: the cover the reader set, else the first attachment that is an
 * image. Read here rather than at each surface, so the gallery tile, its floating header row and a
 * still of the board on a slide all answer "which picture is this card's" the same way — the third
 * of those had no answer at all until the projector asked for one (N-36).
 */
export function kanbanCardCover(item: KanbanItem): string | undefined {
  const imageFile = item.files?.find(
    (file) => file.mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name),
  )
  return item.cover || imageFile?.url
}
