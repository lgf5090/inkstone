import { useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { projectDayToStamp } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { CardBadges, OptionChip } from './CardBadges'

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

export function GalleryView({ cards, properties, showTitle, showBadges, badgesFor, onOpenCard }: { cards: ProjectCard[], properties: ProjectProperty[], showTitle: boolean, showBadges: boolean, badgesFor: (cardId: string) => ProjectCardBadges, onOpenCard: (id: string) => void }): ReactElement {
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
            <span key={property.id} className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {property.type === 'select' && card.values[property.id] ? <OptionChip property={property} value={card.values[property.id]!} /> : projectPropertyDisplayText(card, property)}
            </span>
          ))}
          {showBadges && <CardBadges badges={badgesFor(card.id)} />}
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
  const today = new Date()
  const isToday = (day: number | null): boolean => day !== null && day === today.getDate() && monthIndex === today.getMonth() && year === today.getFullYear()

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>
            {t('project.view.today')}
          </Button>
          <div className="flex items-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
            <IconButton label={t('project.view.prev_month')} size="sm" onClick={() => shift(-1)}><ChevronLeft size={15} /></IconButton>
            <div className="h-3.5 w-px bg-[var(--border-subtle)]" />
            <IconButton label={t('project.view.next_month')} size="sm" onClick={() => shift(1)}><ChevronRight size={15} /></IconButton>
          </div>
          <h2 className="ml-2 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {month.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}
          </h2>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1.5 pb-1 border-b border-[var(--border-subtle)] text-center">
        {weekdays.map((day, i) => (
          <div key={i} className="py-1 text-[length:var(--text-11)] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
            {day}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1.5 overflow-y-auto pt-1.5">
        {cells.map((day, i) => {
          const current = isToday(day)
          const dayCards = day !== null ? (byDay.get(day) ?? []) : []
          return (
            <div
              key={i}
              className={`group relative flex min-h-16 flex-col rounded-[var(--r-md)] border p-1.5 transition-colors ${
                day === null
                  ? 'border-transparent bg-[var(--bg-sunken)]/30 opacity-40'
                  : current
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]/20 shadow-[0_0_0_1px_var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-xs)]'
              }`}
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
                  <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[length:var(--text-12)] ${
                    current
                      ? 'bg-[var(--accent)] font-bold text-white shadow-sm'
                      : 'font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'
                  }`}>
                    {day}
                  </span>
                  <div className="mt-1 flex-1 space-y-1 overflow-y-auto">
                    {dayCards.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        data-project-card={card.id}
                        draggable={canEdit}
                        onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                        className="group/chip flex w-full items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-left text-[length:var(--text-12)] shadow-[var(--shadow-xs)] transition-all hover:border-[var(--accent)] hover:shadow-[var(--shadow-sm)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        onClick={() => onOpenCard(card.id)}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
                          {card.title || t('project.board.untitled_card')}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}