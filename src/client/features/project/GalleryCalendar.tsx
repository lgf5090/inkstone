import { useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectComment, ProjectContent, ProjectProperty } from '@shared/project/model'
import { projectCardBadges } from '@shared/project/badges'
import { projectDayToStamp } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'
import { IconButton } from '../../components/primitives'
import { CardBadges } from './CardBadges'

function dateFrom(card: ProjectCard, propertyId: string | undefined): number | null {
  if (!propertyId) return null
  const raw = card.values[propertyId] ?? ''
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const from = (parsed as { from?: number })?.from
    if (typeof from === 'number') return from
  } catch {
    const stamp = Number(raw)
    if (Number.isFinite(stamp)) return stamp
  }
  return null
}

export function GalleryView({ cards, contents, comments, properties, showTitle, showBadges, onOpenCard }: { cards: ProjectCard[], contents: ProjectContent[], comments: ProjectComment[], properties: ProjectProperty[], showTitle: boolean, showBadges: boolean, onOpenCard: (id: string) => void }): ReactElement {
  return (
    <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 overflow-y-auto p-3">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          data-project-card={card.id}
          className="flex flex-col items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-left shadow-[var(--shadow-sm)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={() => onOpenCard(card.id)}
        >
          <span aria-hidden="true" className="flex h-16 w-full items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)] text-[length:var(--text-20)]">
            {card.icon || <SquareKanban size={24} className="text-[var(--text-quaternary)]" />}
          </span>
          {showTitle && <span className="min-w-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>}
          {properties.slice(0, 3).map((property) => (
            <span key={property.id} className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{projectPropertyDisplayText(card, property)}</span>
          ))}
          {showBadges && <CardBadges badges={projectCardBadges(contents.filter((block) => block.cardId === card.id), comments.filter((comment) => comment.cardId === card.id))} />}
        </button>
      ))}
    </div>
  )
}

export function CalendarView({ cards, properties, datePropertyId, canEdit, onOpenCard, onPatchCard }: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  canEdit: boolean
  onOpenCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
}): ReactElement {
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const propertyId = datePropertyId ?? properties.find((p) => p.type === 'date')?.id
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const firstWeekday = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)
  const byDay = new Map<number, ProjectCard[]>()
  for (const card of cards) {
    const stamp = dateFrom(card, propertyId)
    if (stamp === null) continue
    const date = new Date(stamp)
    if (date.getFullYear() === year && date.getMonth() === monthIndex) {
      const day = date.getDate()
      byDay.set(day, [...(byDay.get(day) ?? []), card])
    }
  }
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(year, monthIndex, i + 1 - firstWeekday)
    return date.toLocaleDateString(undefined, { weekday: 'short' })
  })
  const shift = (delta: number) => setMonth(new Date(year, monthIndex + delta, 1))

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-2 flex items-center gap-2">
        <IconButton label={t('project.view.prev_month')} size="sm" onClick={() => shift(-1)}><ChevronLeft size={15} /></IconButton>
        <span className="min-w-0 flex-1 text-center text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {month.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
        </span>
        <IconButton label={t('project.view.next_month')} size="sm" onClick={() => shift(1)}><ChevronRight size={15} /></IconButton>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1 overflow-y-auto">
        {weekdays.map((day, i) => <div key={i} className="pb-1 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{day}</div>)}
        {cells.map((day, i) => (
          <div
            key={i}
            className={`min-h-16 rounded-[var(--r-sm)] border border-[var(--border-subtle)] p-1 ${day === null ? 'opacity-40' : ''}`}
            onDragOver={(event) => { if (day !== null && canEdit && propertyId) event.preventDefault() }}
            onDrop={(event) => {
              if (day === null || !canEdit || !propertyId) return
              event.preventDefault()
              const cardId = event.dataTransfer.getData('text/plain')
              if (cardId) void onPatchCard(cardId, { values: { [propertyId]: JSON.stringify({ from: projectDayToStamp(new Date(year, monthIndex, day)) }) } })
            }}
          >
            {day !== null && (
              <>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{day}</span>
                <div className="mt-1 space-y-1">
                  {(byDay.get(day) ?? []).map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      data-project-card={card.id}
                      draggable={canEdit}
                      onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                      className="block w-full truncate rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-1 py-0.5 text-left text-[length:var(--text-11)] text-[var(--accent-on-soft)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      onClick={() => onOpenCard(card.id)}
                    >
                      {card.title || t('project.board.untitled_card')}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}