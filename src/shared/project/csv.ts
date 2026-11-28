/**
 * CSV export of a board's cards (§6.5). Columns are the visible properties in board order (not view
 * column order); a calendar view appends its date property if it is not already shown. Two deliberate
 * deviations from the reference are registered in the plan: a UTF-8 BOM so Excel reads Chinese, and
 * header cells escaped like data cells (the reference left them raw, so a comma in a property name
 * broke the file). The reference's `#`→token dance existed only for its data-URI transport; raw CSV
 * keeps `#` literal, which removes that whole class of bug rather than patching it.
 */
import type { ProjectBoardBundle, ProjectCard, ProjectPeople, ProjectProperty } from './model'
import { projectPersonLabel } from './model'
import { parseProjectDateValue, projectStampToDay } from './date'

export interface ProjectCsvOptions {
  visiblePropertyIds?: string[]
  viewType?: string
  dateDisplayPropertyId?: string
  nameLabel?: string
}

const MULTI_VALUE_TYPES = new Set(['multiSelect', 'multiPerson'])
const ROW_SEPARATOR = '\r\n'
const BOM = '\uFEFF'

/**
 * Spreadsheet apps evaluate a cell whose text starts with `=`, `+`, `-` or `@` even when the field is
 * quoted, so a card title can become a formula. A leading apostrophe is the portable text marker and
 * is hidden by Excel itself; a plain negative number is not a formula and keeps its numeric cell.
 */
function formulaSafe(value: string): string {
  const trimmed = value.trimStart()
  if (/^[=+@\t\r\n]/.test(trimmed)) return `'${value}`
  if (/^-(?![\d.])/.test(trimmed)) return `'${value}`
  return value
}

function escapeCell(value: string): string {
  return `"${formulaSafe(value).replace(/"/g, '""')}"`
}

function escapeNumberCell(raw: string): string {
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) ? raw : escapeCell(raw)
}

function csvDate(value: string): string {
  const parsed = parseProjectDateValue(value)
  if (parsed?.from === undefined) return value
  const day = (stamp: number): string => {
    const date = projectStampToDay(stamp, parsed.includeTime === true, parsed.timeZone)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const from = day(parsed.from)
  return parsed.to === undefined || parsed.to === parsed.from ? from : `${from} – ${day(parsed.to)}`
}

function exportCell(card: ProjectCard, property: ProjectProperty, people: ProjectPeople): string {
  const error = card.valueErrors?.[property.id]
  const raw = error ? `#${error}` : card.values[property.id] ?? ''
  switch (property.type) {
    case 'number':
      return escapeNumberCell(raw)
    case 'createdBy':
      return escapeCell(projectPersonLabel(people, card.createdBy))
    case 'updatedBy':
      return escapeCell(projectPersonLabel(people, card.modifiedBy))
    case 'person':
      return escapeCell(projectPersonLabel(people, raw))
    case 'select':
      return escapeCell(property.options.find((option) => option.id === raw)?.value ?? raw)
    case 'date':
      return escapeCell(csvDate(raw))
    case 'createdTime':
      return escapeCell(new Date(card.createAt).toISOString())
    case 'updatedTime':
      return escapeCell(new Date(card.updateAt).toISOString())
    default: {
      if (MULTI_VALUE_TYPES.has(property.type)) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            const ids = parsed.map(String)
            const labels = ids.map((id) => property.type === 'multiPerson'
              ? projectPersonLabel(people, id)
              : property.options.find((option) => option.id === id)?.value ?? id)
            return escapeCell(labels.join('|'))
          }
        } catch {
          // A scalar masquerading as a multi-value falls through to ordinary text.
        }
      }
      return escapeCell(raw)
    }
  }
}

export function projectBoardToCsv(bundle: ProjectBoardBundle, options: ProjectCsvOptions = {}): string {
  const visible = options.visiblePropertyIds ? new Set(options.visiblePropertyIds) : null
  let columns = bundle.properties.filter((property) => !visible || visible.has(property.id))
  if (options.viewType === 'calendar' && options.dateDisplayPropertyId) {
    const dateProperty = bundle.properties.find((property) => property.id === options.dateDisplayPropertyId)
    if (dateProperty && !columns.some((property) => property.id === dateProperty.id)) columns = [...columns, dateProperty]
  }
  const header = [options.nameLabel ?? 'Name', ...columns.map((property) => property.name)].map(escapeCell).join(',')
  const rows = bundle.cards.map((card) =>
    [escapeCell(card.title), ...columns.map((property) => exportCell(card, property, bundle.people))].join(','),
  )
  return BOM + [header, ...rows].join(ROW_SEPARATOR) + ROW_SEPARATOR
}