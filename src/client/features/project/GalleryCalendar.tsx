import { useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { parseProjectDateValue, projectDayToStamp, projectStampToDay } from '@shared/project/date'
import { projectOptionCssColor } from '@shared/project/option-color'
import { groupProjectCards, projectOptionLabel, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t, useLocale } from '../../lib/i18n'
import { buildMonthGridCells } from '../../components/calendar-grids'
import { resolveWeekStart, useCalendarDisplayPrefs } from '../../lib/calendar-display-prefs'
import { dateKey, narrowWeekdayLabels, startOfWeek } from '../../lib/time'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { Segmented } from '../../components/form'
import { prompt } from '../../components/overlay'
import { CardBadges, OptionChip } from './CardBadges'
import { createProjectCard } from './api'

function cardDayKeys(card: ProjectCard, propertyId: string | undefined): { from: number, to: number } | null {
  if (!propertyId) return null
  const value = parseProjectDateValue(card.values[propertyId] ?? '')
  if (value?.from === undefined) return null
  const includeTime = value.includeTime === true
  const from = projectStampToDay(value.from, includeTime).getTime()
  const to = value.to === undefined ? from : Math.max(from, projectStampToDay(value.to, includeTime).getTime())
  return { from, to }
}

export function GalleryView({
  cards,
  properties,
  showTitle,
  showBadges,
  badgesFor,
  onOpenCard,
  onCardContextMenu,
  groupById,
  allProperties = [],
  collapsedOptionIds = [],
  onToggleGroup,
  canEdit = false,
  onAddCard,
  coverFor,
}: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  showTitle: boolean
  showBadges: boolean
  badgesFor: (cardId: string) => ProjectCardBadges
  onOpenCard: (id: string) => void
  onCardContextMenu?: (event: MouseEvent, card: ProjectCard) => void
  groupById?: string
  allProperties?: ProjectProperty[]
  collapsedOptionIds?: string[]
  onToggleGroup?: (key: string) => void
  canEdit?: boolean
  onAddCard?: (title: string, optionId: string) => Promise<void>
  coverFor?: (cardId: string) => string | null
}): ReactElement {
  const groups = groupProjectCards(cards, groupById, allProperties)
  const groupProperty = allProperties.find((property) => property.id === groupById)
  // An empty group still gets its section and its add tile, the way an empty kanban column does.
  const entries: [string, ProjectCard[]][] = groupProperty
    ? [...groupProperty.options.map((option) => option.id), ''].map((key) => [key, groups.get(key) ?? []])
    : [...groups.entries()]
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      {entries.map(([key, groupCards]) => {
        const collapsed = collapsedOptionIds.includes(key)
        const label = key === '' ? t('project.view.no_value') : projectOptionLabel(groupProperty!, key)
        return (
          <section key={key || 'empty'} aria-label={label} data-gallery-group={key}>
            {groupById && (
              <button
                type="button"
                aria-expanded={!collapsed}
                className="mb-2 flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                onClick={() => onToggleGroup?.(key)}
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {groupProperty && key !== '' ? <OptionChip property={groupProperty} value={key} /> : <span>{label}</span>}
                <span className="text-[var(--text-tertiary)]">{groupCards.length}</span>
              </button>
            )}
            {!collapsed && (
              <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {groupCards.map((card) => {
                  const cover = coverFor?.(card.id) ?? null
                  return (
                    <button
                      key={card.id}
                      type="button"
                      data-project-card={card.id}
                      className="flex flex-col items-start gap-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-left shadow-[var(--shadow-sm)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      onClick={() => onOpenCard(card.id)}
                      onContextMenu={(event) => onCardContextMenu?.(event, card)}
                    >
                      {cover
                        ? <img src={cover} alt="" className="h-24 w-full rounded-[var(--r-sm)] object-cover" />
                        : (
                          <span aria-hidden="true" className="flex h-24 w-full items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)] text-[length:var(--text-20)]">
                            {card.icon || <SquareKanban size={24} className="text-[var(--text-quaternary)]" />}
                          </span>
                        )}
                      {showTitle && <span className="min-w-0 max-w-full truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>}
                      {properties.slice(0, 3).map((property) => (
                        <span key={property.id} className="min-w-0 max-w-full truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                          {property.type === 'select' && card.values[property.id] ? <OptionChip property={property} value={card.values[property.id]!} /> : projectPropertyDisplayText(card, property)}
                        </span>
                      ))}
                      {showBadges && <CardBadges badges={badgesFor(card.id)} />}
                    </button>
                  )
                })}
                {canEdit && onAddCard && (
                  <div className="flex min-h-32 flex-col justify-center rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] p-3">
                    <GalleryAddTile onAdd={(title) => onAddCard(title, key)} />
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function GalleryAddTile({ onAdd }: { onAdd: (title: string) => Promise<void> }): ReactElement {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  if (!open) {
    return (
      <button
        type="button"
        className="flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => setOpen(true)}
      >
        <Plus size={13} aria-hidden="true" />{t('project.board.new_card')}
      </button>
    )
  }
  return (
    <form onSubmit={(event) => { event.preventDefault(); const trimmed = title.trim(); if (trimmed) { void onAdd(trimmed); setTitle(''); setOpen(false) } }}>
      <Input
        className="w-full"
        value={title}
        autoFocus
        aria-label={t('project.board.new_card')}
        placeholder={t('project.board.card_placeholder')}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); setTitle('') } }}
        onBlur={() => { if (!title.trim()) setOpen(false) }}
      />
    </form>
  )
}

interface CalendarCell {
  day: number
  inMonth: boolean
  date: Date
  key: string
}

export function CalendarView({ cards, boardId, properties, datePropertyId, canEdit, onOpenCard, onPatchCard, onRefresh }: {
  cards: ProjectCard[]
  boardId: string
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

  const prefs = useCalendarDisplayPrefs()
  const weekStart = resolveWeekStart(prefs.weekStart, locale)
  const todayKey = dateKey(new Date())

  const cardRanges = useMemo(() => cards.map((card) => ({ card, range: cardDayKeys(card, propertyId) })), [cards, propertyId])

  // One pass builds the day index; each of the 42 cells then reads its own bucket instead of
  // rescanning every card, and the bucket key is the local day the reader resolved, not the raw stamp.
  const cardsByDay = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const { card, range } of cardRanges) {
      if (!range) continue
      for (let stamp = range.from; stamp <= range.to; stamp += 86_400_000) {
        const key = dateKey(new Date(stamp))
        const list = map.get(key)
        if (list) list.push(card)
        else map.set(key, [card])
      }
    }
    return map
  }, [cardRanges])

  const getCardsForDay = (date: Date): ProjectCard[] => cardsByDay.get(dateKey(date)) ?? []

  const monthCells: CalendarCell[] = useMemo(() => {
    return buildMonthGridCells(year, monthIndex, weekStart, todayKey).map((cell) => ({
      day: cell.day,
      inMonth: cell.inMonth,
      date: cell.date,
      key: cell.key,
    }))
  }, [year, monthIndex, weekStart, todayKey])

  const weekCells: CalendarCell[] = useMemo(() => {
    const first = startOfWeek(currentDate, weekStart)
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(first)
      date.setDate(first.getDate() + index)
      return { day: date.getDate(), inMonth: date.getMonth() === monthIndex, date, key: dateKey(date) }
    })
  }, [currentDate, monthIndex, weekStart])

  const weekdays = useMemo(() => narrowWeekdayLabels(locale, weekStart), [locale, weekStart])

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
    if (!propertyId) return
    const name = await prompt({ title: t('project.board.new_card'), confirmLabel: t('common.save') })
    if (!name || !name.trim()) return
    await createProjectCard(boardId, {
      title: name.trim(),
      values: { [propertyId]: JSON.stringify({ from: projectDayToStamp(date) }) },
    })
    void onRefresh?.()
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
              {canEdit && propertyId && (cell.inMonth || mode === 'week') && (
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
                        style={{ backgroundColor: (statusOption && projectOptionCssColor(statusOption.color)) ?? 'var(--accent)' }}
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