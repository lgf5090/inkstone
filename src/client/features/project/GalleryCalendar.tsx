import { useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, ListTodo, Plus, SquareKanban } from 'lucide-react'
import type { ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { parseProjectDateValue, projectDayToStamp, projectStampToDay } from '@shared/project/date'
import { PROJECT_CALENDAR_RIBBON_PX, projectCalendarCardColor, projectCalendarDayChips, projectCalendarOverdue, projectCalendarRibbons } from '@shared/project/calendar-layout'
import { projectCardDays } from '@shared/project/timeline-layout'
import { groupProjectCards, projectOptionLabel, projectPropertyDisplayText } from '@shared/project/view-eval'
import { t, useLocale } from '../../lib/i18n'
import { buildMonthGridCells } from '../../components/calendar-grids'
import { resolveWeekStart, useCalendarDisplayPrefs } from '../../lib/calendar-display-prefs'
import { dateKey, narrowWeekdayLabels, startOfWeek } from '../../lib/time'
import { isImeComposing } from '../../lib/ime'
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const ids = new Set(cards.map((card) => card.id))
  const children = new Map<string, ProjectCard[]>()
  for (const card of cards) {
    if (!card.parentId || !ids.has(card.parentId)) continue
    const list = children.get(card.parentId)
    if (list) list.push(card)
    else children.set(card.parentId, [card])
  }
  // A subtask belongs under its parent's tile, not beside it: only roots are grouped.
  const roots = cards.filter((card) => !card.parentId || !ids.has(card.parentId))
  const groups = groupProjectCards(roots, groupById, allProperties)
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
                {groupCards.map((card) => (
                  <GalleryTile
                    key={card.id}
                    card={card}
                    cover={coverFor?.(card.id) ?? null}
                    properties={properties}
                    showTitle={showTitle}
                    showBadges={showBadges}
                    subtasks={children.get(card.id) ?? []}
                    expanded={expanded.has(card.id)}
                    onToggle={() => setExpanded((current) => {
                      const nextSet = new Set(current)
                      if (nextSet.has(card.id)) nextSet.delete(card.id)
                      else nextSet.add(card.id)
                      return nextSet
                    })}
                    childCover={(id) => coverFor?.(id) ?? null}
                    childBadges={badgesFor}
                    onOpenCard={onOpenCard}
                    onCardContextMenu={onCardContextMenu}
                  />
                ))}
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
        onKeyDown={(event) => { if (event.key === 'Escape' && !isImeComposing(event)) { setOpen(false); setTitle('') } }}
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

  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const todayStamp = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }, [])

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
  const selectedCards = selectedDay ? (cardsByDay.get(selectedDay) ?? []) : []
  const ribbons = useMemo(
    () => projectCalendarRibbons(cards, propertyId, properties, activeCells.map((cell) => dateKey(cell.date)), (stamp) => dateKey(new Date(stamp))),
    [cards, propertyId, properties, activeCells],
  )

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
          const key = dateKey(cell.date)
          const dayRibbons = ribbons.get(key) ?? []
          const chips = projectCalendarDayChips(cards, propertyId, key, (stamp) => dateKey(new Date(stamp)))
          const selected = selectedDay === key
          return (
            <div
              key={cell.key}
              data-calendar-day={key}
              className={`group relative flex min-h-20 flex-col overflow-hidden rounded-[var(--r-sm)] border p-1 transition-colors ${
                !cell.inMonth && mode === 'month'
                  ? 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]'
                  : current
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]'
              } ${selected ? 'outline outline-2 -outline-offset-2 outline-[var(--accent)]' : ''}`}
              onDragOver={(event) => { if (canEdit && propertyId) event.preventDefault() }}
              onDrop={(event) => handleDrop(cell, event)}
            >
              <button
                type="button"
                aria-label={key}
                aria-pressed={selected}
                className="absolute inset-0 z-0"
                onClick={() => setSelectedDay(selected ? null : key)}
              />
              <div className="pointer-events-none relative z-10 h-0" data-calendar-ribbons={key}>
                {dayRibbons.map((ribbon) => (
                  <span
                    key={ribbon.card.id}
                    title={ribbon.card.title}
                    className={`absolute h-1 ${ribbon.start ? 'left-1 rounded-l-[var(--r-xs)]' : 'left-0'} ${ribbon.end ? 'right-1 rounded-r-[var(--r-xs)]' : 'right-0'}`}
                    style={{ top: `${ribbon.lane * PROJECT_CALENDAR_RIBBON_PX}px`, backgroundColor: ribbon.color }}
                  />
                ))}
              </div>
              <span
                className={`relative z-10 inline-flex h-5 w-5 items-center justify-center rounded-full text-[length:var(--text-11)] ${
                  current ? 'bg-[var(--accent)] font-bold text-white' : 'font-medium text-[var(--text-tertiary)]'
                }`}
                style={{ marginTop: `${dayRibbons.length ? dayRibbons.length * PROJECT_CALENDAR_RIBBON_PX + 2 : 0}px` }}
              >
                {cell.day}
              </span>
              {canEdit && propertyId && (cell.inMonth || mode === 'week') && (
                <button
                  type="button"
                  aria-label={t('project.board.new_card')}
                  className="absolute right-1 top-1 z-20 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => { event.stopPropagation(); void quickAdd(cell.date) }}
                >
                  <Plus size={12} />
                </button>
              )}
              <div className="relative z-10 mt-0.5 flex-1 space-y-0.5 overflow-hidden">
                {chips.map(({ card, starting }) => {
                  const days = projectCardDays(card, propertyId)!
                  const done = isProjectCardDone(card, properties)
                  const overdue = projectCalendarOverdue(card, properties, days.end, todayStamp)
                  return (
                    <button
                      key={card.id}
                      type="button"
                      data-project-card={card.id}
                      data-calendar-start={starting ? '' : undefined}
                      draggable={canEdit}
                      onDragStart={(event) => { event.dataTransfer.setData('text/plain', card.id) }}
                      className={`block w-full truncate rounded-[var(--r-xs)] border-l-[3px] px-1 py-0.5 text-left text-[length:var(--text-10)] ${
                        starting ? 'bg-[var(--accent-soft)] font-medium' : 'bg-[var(--bg-sunken)]'
                      } ${done ? 'line-through opacity-50' : ''} ${overdue ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'} hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
                      style={{ borderLeftColor: projectCalendarCardColor(card, properties) }}
                      onClick={(event) => { event.stopPropagation(); onOpenCard(card.id) }}
                    >
                      {card.title || t('project.board.untitled_card')}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      {selectedDay && (
        <aside className="mt-2 shrink-0 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2" aria-label={t('project.calendar.day_panel')} data-calendar-panel={selectedDay}>
          <div className="mb-1 flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{selectedDay}</h3>
            <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.board.cards_count', { count: selectedCards.length })}</span>
            <Button size="sm" variant="ghost" onClick={() => setSelectedDay(null)}>{t('common.close')}</Button>
          </div>
          {selectedCards.length === 0
            ? <p className="px-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.calendar.day_empty')}</p>
            : (
              <ul className="space-y-0.5">
                {selectedCards.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[var(--r-sm)] border-l-[3px] px-2 py-1 text-left text-[length:var(--text-12)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      style={{ borderLeftColor: projectCalendarCardColor(card, properties) }}
                      onClick={() => onOpenCard(card.id)}
                    >
                      <span className={`min-w-0 flex-1 truncate ${isProjectCardDone(card, properties) ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>{card.title || t('project.board.untitled_card')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </aside>
      )}
    </div>
  )
}
/**
 * One gallery tile, with its subtasks folded underneath it.
 *
 * The reference keeps a parent's children out of the sibling grid: a tile carries the count, and
 * opening it reveals the children indented inside the same tile. Listing them beside the parent made
 * a three-step task read as four unrelated cards.
 */
function GalleryTile({ card, cover, properties, showTitle, showBadges, subtasks, expanded, onToggle, childCover, childBadges, onOpenCard, onCardContextMenu }: {
  card: ProjectCard
  cover: string | null
  properties: ProjectProperty[]
  showTitle: boolean
  showBadges: boolean
  subtasks: ProjectCard[]
  expanded: boolean
  onToggle: () => void
  childCover: (id: string) => string | null
  childBadges: (id: string) => ProjectCardBadges
  onOpenCard: (id: string) => void
  onCardContextMenu?: (event: MouseEvent, card: ProjectCard) => void
}): ReactElement {
  const face = (entry: ProjectCard, image: string | null) => (
    <>
      {image
        ? <img src={image} alt="" className="h-24 w-full rounded-[var(--r-sm)] object-cover" />
        : (
          <span aria-hidden="true" className="flex h-24 w-full items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)] text-[length:var(--text-20)]">
            {entry.icon || <SquareKanban size={24} className="text-[var(--text-quaternary)]" />}
          </span>
        )}
      {showTitle && <span className="min-w-0 max-w-full truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{entry.title || t('project.board.untitled_card')}</span>}
      {properties.slice(0, 3).map((property) => (
        <span key={property.id} className="min-w-0 max-w-full truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {property.type === 'select' && entry.values[property.id] ? <OptionChip property={property} value={entry.values[property.id]!} /> : projectPropertyDisplayText(entry, property)}
        </span>
      ))}
      {showBadges && <CardBadges badges={childBadges(entry.id)} />}
    </>
  )
  return (
    <div className="flex flex-col gap-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 shadow-[var(--shadow-sm)]" data-gallery-tile={card.id}>
      <button
        type="button"
        data-project-card={card.id}
        aria-label={card.title || t('project.board.untitled_card')}
        className="flex flex-col items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        onClick={() => onOpenCard(card.id)}
        onContextMenu={(event) => onCardContextMenu?.(event, card)}
      >
        {face(card, cover)}
      </button>
      {subtasks.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
          className="flex items-center gap-1 self-start rounded-[var(--r-full)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          onClick={onToggle}
        >
          <ListTodo size={11} aria-hidden="true" />
          <span>{subtasks.length}</span>
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      )}
      {expanded && (
        <div className="space-y-2 border-l-2 border-[var(--border-subtle)] pl-2" data-gallery-children={card.id}>
          {subtasks.map((child) => (
            <button
              key={child.id}
              type="button"
              data-project-card={child.id}
              aria-label={child.title || t('project.board.untitled_card')}
              className="flex w-full flex-col items-start gap-1 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] p-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => onOpenCard(child.id)}
              onContextMenu={(event) => onCardContextMenu?.(event, child)}
            >
              <span className="flex items-center gap-1 text-[length:var(--text-12)] text-[var(--text-primary)]">
                <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 truncate">{child.title || t('project.board.untitled_card')}</span>
              </span>
              {childCover(child.id) && <img src={childCover(child.id)!} alt="" className="h-16 w-full rounded-[var(--r-sm)] object-cover" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
