/**
 * Board context for the assistant (X-6): bounded, countable facts about the open board — never
 * instructions — mirroring the todo context's discipline. The dock sends these as page facts so the
 * model can answer "what's due this week" or "split this card" against real data.
 */
import type { ProjectBoardBundle, ProjectViewFields } from './model'
import { matchProjectFilterGroup, sortProjectCards } from './view-eval'

export const MAX_PROJECT_CONTEXT_CARDS = 20
const MAX_TITLE = 200

export function buildProjectAssistantFacts(bundle: ProjectBoardBundle, fields: ProjectViewFields): string[] {
  const visible = sortProjectCards(
    bundle.cards.filter((card) => matchProjectFilterGroup(card, fields.filter, bundle.properties)),
    fields.sortOptions,
    bundle.properties,
  )
  const facts: string[] = [
    `board: ${bundle.board.title || 'untitled'}`,
    `cards: ${bundle.cards.length}`,
    `views: ${bundle.views.map((view) => view.viewType).join(', ')}`,
  ]
  const statusProperty = bundle.properties.find((property) => property.id === fields.groupById)
  if (statusProperty) facts.push(`grouped by: ${statusProperty.name}`)
  for (const card of visible.slice(0, MAX_PROJECT_CONTEXT_CARDS)) {
    const values = bundle.properties
      .map((property) => {
        const raw = card.values[property.id]
        if (!raw) return null
        const label = property.type === 'select' ? property.options.find((o) => o.id === raw)?.value ?? raw : raw
        return `${property.name}=${label}`
      })
      .filter(Boolean)
      .join(', ')
    facts.push(`card: ${card.title.slice(0, MAX_TITLE)}${values ? ` (${values})` : ''}`)
  }
  return facts
}