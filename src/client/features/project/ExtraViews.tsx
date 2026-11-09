/**
 * The four added views (X-1): a compact list, a timeline and Gantt laid over the cards' date range,
 * and a distribution chart. They reuse the same filtered/sorted cards and the shared grouping; the
 * Gantt additionally surfaces blocking dependencies as a badge rather than drawn edges.
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react'
import type { ProjectCard, ProjectCardLink, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards])
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const card of cards) {
      if (card.parentId && cardIds.has(card.parentId)) {
        const list = map.get(card.parentId)
        if (list) list.push(card)
        else map.set(card.parentId, [card])
      }
    }
    return map
  }, [cards, cardIds])

  const rootCards = useMemo(() => cards.filter((c) => !c.parentId || !cardIds.has(c.parentId)), [cards, cardIds])

  return (
    <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
      {rootCards.map((card) => {
        const cardSubtasks = subtasksByParent.get(card.id) ?? []
        const hasSubtasks = cardSubtasks.length > 0
        const isExpanded = expanded.has(card.id)
        const doneCount = cardSubtasks.filter((s) => isProjectCardDone(s, properties)).length
        return (
          <Fragment key={card.id}>
            <li>
              <div className="flex w-full items-center gap-1.5 px-3 py-1">
                {hasSubtasks ? (
                  <button
                    type="button"
                    aria-label={isExpanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                    aria-expanded={isExpanded}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    onClick={() => toggleExpand(card.id)}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => onOpenCard(card.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                    {card.title || t('project.board.untitled_card')}
                  </span>
                  {hasSubtasks && (
                    <span className="shrink-0 rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                      {doneCount}/{cardSubtasks.length}
                    </span>
                  )}
                  {properties.slice(0, 3).map((property) => (
                    <span key={property.id} className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {projectPropertyDisplayText(card, property)}
                    </span>
                  ))}
                </button>
              </div>
            </li>
            {hasSubtasks && isExpanded && cardSubtasks.map((subtask) => {
              const isDone = isProjectCardDone(subtask, properties)
              return (
                <li key={subtask.id} className="bg-[var(--bg-sunken)]/40">
                  <div className="flex w-full items-center gap-1.5 py-1 pl-9 pr-3">
                    <CornerDownRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      onClick={() => onOpenCard(subtask.id)}
                    >
                      <span className={`min-w-0 flex-1 truncate text-[length:var(--text-12)] ${isDone ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
                        {subtask.title || t('project.board.untitled_card')}
                      </span>
                      {properties.slice(0, 3).map((property) => (
                        <span key={property.id} className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                          {projectPropertyDisplayText(subtask, property)}
                        </span>
                      ))}
                    </button>
                  </div>
                </li>
              )
            })}
          </Fragment>
        )
      })}
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
  const max = entries.reduce((acc, [, list]) => Math.max(acc, list.length), 1)
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