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

export interface ProjectCsvOptions {
  visiblePropertyIds?: string[]
  viewType?: string
  dateDisplayPropertyId?: string
  nameLabel?: string
}

const MULTI_VALUE_TYPES = new Set(['multiSelect', 'multiPerson'])
const ROW_SEPARATOR = '\r\n'
const BOM = '\uFEFF'

function escapeCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function exportCell(card: ProjectCard, property: ProjectProperty, people: ProjectPeople): string {
  const raw = card.values[property.id] ?? ''
  switch (property.type) {
    case 'number':
      return raw
    case 'createdBy':
      return escapeCell(projectPersonLabel(people, card.createdBy))
    case 'updatedBy':
      return escapeCell(projectPersonLabel(people, card.modifiedBy))
    case 'person':
      return escapeCell(projectPersonLabel(people, raw))
    case 'createdTime':
      return escapeCell(String(card.createAt))
    case 'updatedTime':
      return escapeCell(String(card.updateAt))
    default: {
      if (MULTI_VALUE_TYPES.has(property.type)) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            const ids = parsed.map(String)
            return escapeCell((property.type === 'multiPerson' ? ids.map((id) => projectPersonLabel(people, id)) : ids).join('|'))
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