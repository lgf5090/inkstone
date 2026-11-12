/**
 * Board-as-Markdown (X-12): a readable report of a board's cards, grouped by the active grouping
 * property when present, with each card's property values and text content. Pure so it can be tested
 * and reused by any export surface.
 */
import type { ProjectBoardBundle, ProjectPeople, ProjectProperty } from './model'
import { projectMultiValueIds, projectPersonLabel } from './model'
import { groupProjectCards } from './view-eval'

function optionLabel(property: ProjectProperty | undefined, raw: string, people: ProjectPeople): string {
  if (!property) return raw
  if (property.type === 'person') return projectPersonLabel(people, raw)
  if (property.type === 'multiPerson') return projectMultiValueIds(raw).map((id) => projectPersonLabel(people, id)).join(', ')
  if (property.type === 'select') return property.options.find((o) => o.id === raw)?.value ?? raw
  if (property.type === 'multiSelect') {
    try {
      const ids: unknown = JSON.parse(raw)
      if (Array.isArray(ids)) return ids.map((id) => property.options.find((o) => o.id === id)?.value ?? String(id)).join(', ')
    } catch { /* scalar */ }
  }
  return raw
}

export function projectBoardToMarkdown(bundle: ProjectBoardBundle, groupById?: string): string {
  const lines: string[] = [`# ${bundle.board.title || 'Board'}`, '']
  if (bundle.board.description) lines.push(bundle.board.description, '')
  const groups = groupProjectCards(bundle.cards, groupById, bundle.properties)
  const groupProperty = bundle.properties.find((p) => p.id === groupById)
  for (const [key, cards] of groups) {
    if (groupById) lines.push(`## ${key === '' ? 'No value' : optionLabel(groupProperty, key, bundle.people)}`, '')
    for (const card of cards) {
      lines.push(`### ${card.title || 'Untitled'}`, '')
      for (const property of bundle.properties) {
        const raw = card.values[property.id]
        if (raw) lines.push(`- **${property.name}**: ${optionLabel(property, raw, bundle.people)}`)
      }
      const texts = bundle.contents.filter((c) => c.cardId === card.id && c.type === 'text')
      if (texts.length) {
        lines.push('')
        for (const text of texts) lines.push(text.title, '')
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}