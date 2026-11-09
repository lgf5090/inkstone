import { useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Plus, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { projectDayToStamp } from '@shared/project/date'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { t, useLocale } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { prompt } from '../../components/overlay'
import { CardBadges, OptionChip } from './CardBadges'
import { createProjectCard } from './api'

function parseCardDate(card: ProjectCard, propertyId: string | undefined): { from: number, to: number } | null {
  if (!propertyId) return null
  const raw = card.values[propertyId] ?? ''
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const obj = parsed as { from?: number, to?: number }
    if (typeof obj.from === 'number') {
      return { from: obj.from, to: typeof obj.to === 'number' ? obj.to : obj.from }
    }
  } catch {
    const stamp = Number(raw)
    if (Number.isFinite(stamp)) return { from: stamp, to: stamp }
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

interface CalendarCell {
  day: number
  inMonth: boolean
  date: Date
  key: string
}

export function CalendarView({ cards, properties, datePropertyId, canEdit, onOpenCard, onPatchCard, onRefresh }: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  canEdit: boolean
  onOpenCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onRefresh?: () => Promise<void>
}): ReactElement {
  const locale = useLocale()
  const [mode, setMode] = useState<'month' | 'week'>('month')
  const [currentDate, setCurrentDate] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const propertyId = datePropertyId ?? properties.find((p) => p.type === 'date')?.id
  const year = currentDate.getFullYear()
  const monthIndex = currentDate.getMonth()

  const cardRanges = useMemo(() => {
    return cards.map((card) => ({ card, range: parseCardDate(card, propertyId) }))
  }, [cards, propertyId])

  const getCardsForDay = (date: Date): ProjectCard[] => {
    const startStamp = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const endStamp = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
    return cardRanges
      .filter(({ range }) => range !== null && range.from <= endStamp && range.to >= startStamp)
      .map(({ card }) => card)
  }

  const firstWeekday = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const prevMonthDays = new Date(year, monthIndex, 0).getDate()

  const monthCells: CalendarCell[] = useMemo(() => {
    const list: CalendarCell[] = [
      ...Array.from({ length: firstWeekday }, (_, i) => {
        const d = prevMonthDays - firstWeekday + 1 + i
        return {
          day: d,
          inMonth: false,
          date: new Date(year, monthIndex - 1, d),
          key: `prev-${d}`,
        }
      }),
      ...Array.from({ length: daysInMonth }, (_, i) => {
        const d = i + 1
        return {
          day: d,
          inMonth: true,
          date: new Date(year, monthIndex, d),
          key: `curr-${d}`,
        }
      }),
    ]
    const remainder = (7 - (list.length % 7)) % 7
    for (let i = 1; i <= remainder; i++) {
      list.push({
        day: i,
        inMonth: false,
        date: new Date(year, monthIndex + 1, i),
        key: `next-${i}`,
      })
    }
    return list
  }, [year, monthIndex, firstWeekday, daysInMonth, prevMonthDays])

  const weekCells: CalendarCell[] = useMemo(() => {
    const anchor = new Date(currentDate)
    const dayOfWeek = anchor.getDay()
    const sunday = new Date(anchor)
    sunday.setDate(anchor.getDate() - dayOfWeek)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sunday)
      d.setDate(sunday.getDate() + i)
      return {
        day: d.getDate(),
        inMonth: d.getMonth() === monthIndex,
        date: d,
        key: `week-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      }
    })
  }, [currentDate, monthIndex])

  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(2024, 0, 7 + i)))
  }, [locale])

  const shift = (delta: number) => {
    if (mode === 'week') {
      const next = new Date(currentDate)
      next.setDate(next.getDate() + delta * 7)
      setCurrentDate(next)
    } else {
      setCurrentDate(new Date(year, monthIndex + delta, 1))
    }
  }

  const today = new Date()
  const isToday = (cell: CalendarCell): boolean =>
    cell.inMonth &&
    cell.date.getDate() === today.getDate() &&
    cell.date.getMonth() === today.getMonth() &&
    cell.date.getFullYear() === today.getFullYear()

  const quickAdd = async (date: Date) => {
    const name = await prompt({ title: t('project.board.new_card'), confirmLabel: t('common.save') })
    if (!name || !name.trim() || !propertyId) return
    const boardId = cards[0]?.boardId
    if (boardId) {
      await createProjectCard(boardId, {
        title: name.trim(),
        values: { [propertyId]: JSON.stringify({ from: projectDayToStamp(date) }) },
      })
      void onRefresh?.()
    }
  }

  const handleDrop = (cell: CalendarCell, event: React.DragEvent) => {
    if (!canEdit || !propertyId) return
    event.preventDefault()
    const cardId = event.dataTransfer.getData('text/plain')
    if (!cardId) return
    const existing = cardRanges.find((c) => c.card.id === cardId)?.range
    const targetStamp = projectDayToStamp(cell.date)
    if (existing && existing.to > existing.from) {
      const duration = existing.to - existing.from
      void onPatchCard(cardId, { values: { [propertyId]: JSON.stringify({ from: targetStamp, to: targetStamp + duration }) } })
    } else {
      void onPatchCard(cardId, { values: { [propertyId]: JSON.stringify({ from: targetStamp }) } })
    }
  }

  const headerTitle = useMemo(() => {
    if (mode === 'week') {
      const start = weekCells[0]!.date
      const end = weekCells[6]!.date
      return `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`
    }
    return currentDate.toLocaleDateString(locale, { year: 'numeric', month: 'long' })
  }, [mode, weekCells, currentDate, locale])

  const activeCells = mode === 'week' ? weekCells : monthCells

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setCurrentDate(new Date(today.getFullYear(), today.getMonth(), today.getDate()))}>
            {t('project.view.today')}
          </Button>
          <div className="flex items-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
            <IconButton label={t('project.view.prev_month')} size="sm" onClick={() => shift(-1)}><ChevronLeft size={15} /></IconButton>
            <div className="h-3.5 w-px bg-[var(--border-subtle)]" />
            <IconButton label={t('project.view.next_month')} size="sm" onClick={() => shift(1)}><ChevronRight size={15} /></IconButton>
          </div>
          <h2 className="ml-2 text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {headerTitle}
          </h2>
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          size="sm"
          label={t('preview.kanban_calendar_range')}
          options={[
            { value: 'month', label: t('preview.kanban_calendar_month') },
            { value: 'week', label: t('preview.kanban_calendar_week') },
          ]}
        />
      </div>
      <div className="grid grid-cols-7 gap-1.5 pb-1 border-b border-[var(--border-subtle)] text-center">
        {weekdays.map((day, i) => (
          <div key={i} className="py-1 text-[length:var(--text-11)] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
            {day}
          </div>
        ))}
      </div>
      <div className={`grid min-h-0 flex-1 grid-cols-7 gap-1.5 overflow-y-auto pt-1.5 ${mode === 'week' ? 'auto-rows-fr' : ''}`}>
        {activeCells.map((cell) => {
          const current = isToday(cell)
          const dayCards = getCardsForDay(cell.date)
          return (
            <div
              key={cell.key}
              className={`group relative flex min-h-16 flex-col rounded-[var(--r-md)] border p-1.5 transition-colors ${
                !cell.inMonth && mode === 'month'
                  ? 'border-transparent bg-[var(--bg-sunken)]/30 opacity-40'
                  : current
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]/20 shadow-[0_0_0_1px_var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-xs)]'
              }`}
              onDragOver={(event) => { if (canEdit && propertyId) event.preventDefault() }}
              onDrop={(event) => handleDrop(cell, event)}
            >
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[length:var(--text-12)] ${
                !cell.inMonth && mode === 'month'
                  ? 'text-[var(--text-quaternary)]'
                  : current
                    ? 'bg-[var(--accent)] font-bold text-white shadow-sm'
                    : 'font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'
              }`}>
                {cell.day}
              </span>
              {canEdit && (cell.inMonth || mode === 'week') && (
                <button
                  type="button"
                  aria-label={t('project.board.new_card')}
                  className="absolute right-1 top-1 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    void quickAdd(cell.date)
                  }}
                >
                  <Plus size={12} />
                </button>
              )}
              <div className="mt-1 flex-1 space-y-1 overflow-y-auto">
                {dayCards.map((card) => {
                  const isDone = isProjectCardDone(card, properties)
                  const statusProperty = properties.find((p) => p.type === 'select')
                  const statusOption = statusProperty && card.values[statusProperty.id]
                    ? statusProperty.options.find((o) => o.id === card.values[statusProperty.id])
                    : undefined
                  return (
                    <button
                      key={card.id}
                      type="button"
                      data-project-card={card.id}
                      draggable={canEdit}
                      onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                      className={`group/chip flex w-full items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-left text-[length:var(--text-12)] shadow-[var(--shadow-xs)] transition-all hover:border-[var(--accent)] hover:shadow-[var(--shadow-sm)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
                        isDone ? 'opacity-70' : ''
                      }`}
                      onClick={() => onOpenCard(card.id)}
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: statusOption?.color ? `var(--${statusOption.color}, var(--accent))` : 'var(--accent)' }}
                      />
                      <span className={`min-w-0 flex-1 truncate font-medium ${isDone ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
                        {card.title || t('project.board.untitled_card')}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}