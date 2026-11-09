/**
 * The four added views (X-1): a compact list, a timeline and Gantt laid over the cards' date range,
 * and a distribution chart. They reuse the same filtered/sorted cards and the shared grouping; the
 * Gantt additionally surfaces blocking dependencies as a badge rather than drawn edges.
 */
import type { ProjectCard, ProjectCardLink, ProjectProperty } from '@shared/project/model'
import { groupProjectCards, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'

function dateRange(card: ProjectCard, propertyId: string | undefined): { from: number, to: number } | null {
  if (!propertyId) return null
  const raw = card.values[propertyId] ?? ''
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { from?: number, to?: number }
    if (typeof parsed.from === 'number') return { from: parsed.from, to: typeof parsed.to === 'number' ? parsed.to : parsed.from }
  } catch { /* bare stamp */ }
  const stamp = Number(raw)
  return Number.isFinite(stamp) ? { from: stamp, to: stamp } : null
}

export function ListView({ cards, properties, onOpenCard }: { cards: ProjectCard[], properties: ProjectProperty[], onOpenCard: (id: string) => void }) {
  return (
    <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
      {cards.map((card) => (
        <li key={card.id}>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
            {properties.slice(0, 3).map((property) => (
              <span key={property.id} className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{projectPropertyDisplayText(card, property)}</span>
            ))}
          </button>
        </li>
      ))}
    </ul>
  )
}

export function TimelineView({ cards, properties, datePropertyId, links, gantt, onOpenCard }: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  links: ProjectCardLink[]
  gantt: boolean
  onOpenCard: (id: string) => void
}) {
  const propertyId = datePropertyId ?? properties.find((p) => p.type === 'date')?.id
  const ranges = cards.map((card) => ({ card, range: dateRange(card, propertyId) })).filter((entry): entry is { card: ProjectCard, range: { from: number, to: number } } => entry.range !== null)
  if (ranges.length === 0) return <p className="p-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.view.no_dates')}</p>
  let min = Infinity
  let max = -Infinity
  for (const entry of ranges) {
    if (entry.range.from < min) min = entry.range.from
    if (entry.range.to > max) max = entry.range.to
  }
  const span = Math.max(max - min, 1)
  const blocked = new Set(links.filter((l) => l.kind === 'blocks').map((l) => l.toCardId))
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
      {ranges.map(({ card, range }) => {
        const left = ((range.from - min) / span) * 100
        const width = Math.max(((range.to - range.from) / span) * 100, 2)
        return (
          <div key={card.id} className="flex items-center gap-2">
            <button type="button" className="w-40 shrink-0 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
              {card.title || t('project.board.untitled_card')}
            </button>
            <div className="relative h-5 min-w-0 flex-1 rounded-[var(--r-sm)] bg-[var(--bg-sunken)]">
              <div className="absolute top-0 h-full rounded-[var(--r-sm)] bg-[var(--accent-soft)]" style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
            {gantt && blocked.has(card.id) && <span className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('project.view.blocked')}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function ChartView({ cards, properties }: { cards: ProjectCard[], properties: ProjectProperty[] }) {
  const groupProperty = properties.find((p) => p.type === 'select') ?? properties[0]
  const groups = groupProjectCards(cards, groupProperty?.id, properties)
  const entries = [...groups.entries()]
  const max = Math.max(...entries.map(([, list]) => list.length), 1)
  return (
    <div className="flex min-h-0 flex-1 items-end gap-3 overflow-x-auto p-4">
      {entries.map(([key, list]) => (
        <div key={key || 'empty'} className="flex w-24 shrink-0 flex-col items-center gap-1">
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{list.length}</span>
          <div className="w-full rounded-t-[var(--r-sm)] bg-[var(--accent-soft)]" style={{ height: `${(list.length / max) * 160}px` }} />
          <span className="w-full truncate text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {key === '' ? t('project.view.no_value') : groupProperty?.options.find((o) => o.id === key)?.value ?? key}
          </span>
        </div>
      ))}
    </div>
  )
}