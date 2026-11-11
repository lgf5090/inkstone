/**
 * The calendar: a continuous month grid, spanning cards drawn as one bar across the week, and a day
 * panel that says what the selected day means to each card on it.
 *
 * The grid is a real grid — shared hairlines, no gaps — because a month made of separated tiles reads
 * as a list of boxes rather than as time. Ribbons are placed per week with CSS grid columns, so a
 * five-day task is one bar with one label instead of five fragments.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { ProjectCalendarMode, ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import { projectDayToStamp } from '@shared/project/date'
import { projectCardDays } from '@shared/project/timeline-layout'
import { projectCalendarDayChips, projectCalendarDayRoles, projectCalendarOverdue, projectCalendarRibbons, projectCalendarWeekSpans } from '@shared/project/calendar-layout'
import { projectCardColor } from '@shared/project/option-color'
import { t, useLocale } from '../../../lib/i18n'
import { buildMonthGridCells } from '../../../components/calendar-grids'
import { resolveWeekStart, useCalendarDisplayPrefs } from '../../../lib/calendar-display-prefs'
import { dateKey, narrowWeekdayLabels, startOfWeek } from '../../../lib/time'
import { Button, IconButton } from '../../../components/primitives'
import { prompt } from '../../../components/overlay'
import { createProjectCard } from '../api'
import { Legend, Seg, ViewHead, ViewShell } from './shell'

const MAX_CHIPS = 3
const RIBBON_ROW_PX = 18

export interface CalendarProps {
  cards: ProjectCard[]
  boardId: string
  properties: ProjectProperty[]
  datePropertyId?: string
  mode: ProjectCalendarMode
  onModeChange: (mode: ProjectCalendarMode) => void
  canEdit: boolean
  onOpenCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onRefresh?: () => Promise<void>
  descriptionFor?: (cardId: string) => string
}

interface Cell {
  key: string
  day: number
  date: Date
  inMonth: boolean
}

export function CalendarView(props: CalendarProps): ReactElement {
  const { cards, properties, datePropertyId, mode, canEdit } = props
  const locale = useLocale()
  const prefs = useCalendarDisplayPrefs()
  const weekStart = resolveWeekStart(prefs.weekStart, locale)
  const propertyId = datePropertyId ?? properties.find((property) => property.type === 'date')?.id
  const [anchor, setAnchor] = useState(() => new Date())
  const [selected, setSelected] = useState<string | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)
  const dragRef = useRef<{ id: string, from: number, to: number } | null>(null)
  const todayKey = dateKey(new Date())
  const todayStamp = useMemo(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.getTime() }, [])
  const keyOf = useCallback((stamp: number) => dateKey(new Date(stamp)), [])
  const colorOf = useCallback((card: ProjectCard) => projectCardColor(card, properties), [properties])

  const cells: Cell[] = useMemo(() => {
    if (mode === 'month') {
      return buildMonthGridCells(anchor.getFullYear(), anchor.getMonth(), weekStart, todayKey)
        .map((cell) => ({ key: cell.key, day: cell.day, date: cell.date, inMonth: cell.inMonth }))
    }
    if (mode === 'week') {
      const first = startOfWeek(anchor, weekStart)
      return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + index)
        return { key: dateKey(date), day: date.getDate(), date, inMonth: true }
      })
    }
    const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    return [{ key: dateKey(date), day: date.getDate(), date, inMonth: true }]
  }, [anchor, mode, weekStart, todayKey])

  const weeks = useMemo(() => {
    const size = mode === 'day' ? 1 : 7
    const out: Cell[][] = []
    for (let index = 0; index < cells.length; index += size) out.push(cells.slice(index, index + size))
    return out
  }, [cells, mode])

  const dayKeys = useMemo(() => cells.map((cell) => cell.key), [cells])
  const ribbons = useMemo(
    () => projectCalendarRibbons(cards, propertyId, properties, dayKeys, keyOf),
    [cards, propertyId, properties, dayKeys, keyOf],
  )
  const spansByWeek = useMemo(
    () => weeks.map((week) => projectCalendarWeekSpans(week.map((cell) => cell.key), ribbons)),
    [weeks, ribbons],
  )
  const legend = useMemo(() => {
    const seen = new Map<string, { key: string, label: string, color: string, title: string }>()
    for (const list of ribbons.values()) {
      for (const ribbon of list) {
        if (seen.has(ribbon.card.id)) continue
        const days = projectCardDays(ribbon.card, propertyId)!
        seen.set(ribbon.card.id, {
          key: ribbon.card.id,
          label: ribbon.card.title || t('project.board.untitled_card'),
          color: ribbon.color,
          title: `${keyOf(days.start)} → ${keyOf(days.end)}`,
        })
      }
    }
    return [...seen.values()]
  }, [ribbons, propertyId, keyOf])

  const shift = (delta: number): void => {
    const next = new Date(anchor)
    if (mode === 'month') setAnchor(new Date(next.getFullYear(), next.getMonth() + delta, 1))
    else if (mode === 'week') setAnchor(new Date(next.getFullYear(), next.getMonth(), next.getDate() + delta * 7))
    else setAnchor(new Date(next.getFullYear(), next.getMonth(), next.getDate() + delta))
  }

  const title = useMemo(() => {
    if (mode === 'day') return anchor.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    if (mode === 'week') {
      const first = cells[0]!.date
      const last = cells[cells.length - 1]!.date
      return `${first.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}`
    }
    return anchor.toLocaleDateString(locale, { year: 'numeric', month: 'long' })
  }, [anchor, cells, locale, mode])

  const reschedule = (cardId: string, day: Date): void => {
    if (!propertyId) return
    const range = dragRef.current
    const stamp = projectDayToStamp(day)
    const value = range && range.to > range.from
      ? { from: stamp, to: stamp + (range.to - range.from) }
      : { from: stamp }
    void props.onPatchCard(cardId, { values: { [propertyId]: JSON.stringify(value) } })
  }

  /** Pointer drag onto a day: the same path for a mouse and a finger, unlike native drag-and-drop. */
  const startCardDrag = (event: React.PointerEvent, card: ProjectCard): void => {
    if (!canEdit || !propertyId || event.button !== 0) return
    const days = projectCardDays(card, propertyId)
    if (!days) return
    dragRef.current = { id: card.id, from: days.start, to: days.end }
    const startX = event.clientX
    const startY = event.clientY
    let moved = false
    const move = (moveEvent: PointerEvent): void => {
      if (!moved && Math.abs(moveEvent.clientX - startX) < 5 && Math.abs(moveEvent.clientY - startY) < 5) return
      moved = true
      moveEvent.preventDefault()
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-calendar-day]')
      setDropDay(under?.getAttribute('data-calendar-day') ?? null)
    }
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('[data-calendar-day]')
      const key = under?.getAttribute('data-calendar-day')
      setDropDay(null)
      if (!moved || !key) { dragRef.current = null; return }
      const target = cells.find((cell) => cell.key === key)
      if (target) reschedule(card.id, target.date)
      dragRef.current = null
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
  }

  const quickAdd = async (day: Date): Promise<void> => {
    if (!propertyId) return
    const name = await prompt({ title: t('project.board.new_card'), confirmLabel: t('common.save') })
    if (!name || !name.trim()) return
    await createProjectCard(props.boardId, { title: name.trim(), values: { [propertyId]: JSON.stringify({ from: projectDayToStamp(day) }) } })
    void props.onRefresh?.()
  }

  const weekdays = narrowWeekdayLabels(locale, weekStart)
  const selectedRoles = selected ? projectCalendarDayRoles(cards, propertyId, selected, keyOf) : []

  return (
    <ViewShell data-view="calendar">
      <ViewHead icon={<CalendarDays size={15} aria-hidden="true" />} title={title} count={cards.length}>
        <Button size="sm" variant="secondary" onClick={() => { setAnchor(new Date()); setSelected(todayKey) }}>{t('project.view.today')}</Button>
        <IconButton label={t('project.view.prev_month')} size="sm" onClick={() => shift(-1)}><ChevronLeft size={15} /></IconButton>
        <IconButton label={t('project.view.next_month')} size="sm" onClick={() => shift(1)}><ChevronRight size={15} /></IconButton>
        <Seg
          value={mode}
          label={t('project.view.calendar_range')}
          onChange={props.onModeChange}
          options={[
            { value: 'month', label: t('project.view.calendar_month') },
            { value: 'week', label: t('project.view.calendar_week') },
            { value: 'day', label: t('project.view.calendar_day') },
          ]}
        />
      </ViewHead>
      <Legend items={legend} />
      <div className="pv-cal">
        <div className="pv-cal-main">
          {mode !== 'day' && (
            <div className="pv-cal-weekdays">
              {weekdays.map((label, index) => (
                <div key={index} className="pv-cal-weekday" data-weekend={(index + weekStart) % 7 === 0 || (index + weekStart) % 7 === 6}>{label}</div>
              ))}
            </div>
          )}
          <div className="pv-cal-grid pv-scroll" data-mode={mode} data-calendar-grid="">
            {weeks.map((week, weekIndex) => {
              const spans = spansByWeek[weekIndex] ?? []
              const lanes = spans.reduce((max, span) => Math.max(max, span.lane + 1), 0)
              return (
                <div key={week[0]!.key} className="pv-cal-week" style={{ '--pv-ribbon-space': `${lanes * RIBBON_ROW_PX}px` } as React.CSSProperties}>
                  {week.map((cell) => (
                    <CalendarCell
                      key={cell.key}
                      cell={cell}
                      mode={mode}
                      today={cell.key === todayKey}
                      selected={selected === cell.key}
                      dropping={dropDay === cell.key}
                      cards={cards}
                      propertyId={propertyId}
                      properties={properties}
                      colorOf={colorOf}
                      keyOf={keyOf}
                      todayStamp={todayStamp}
                      canEdit={canEdit && Boolean(propertyId)}
                      onSelect={() => setSelected(selected === cell.key ? null : cell.key)}
                      onOpenCard={props.onOpenCard}
                      onCardPointerDown={startCardDrag}
                      onQuickAdd={quickAdd}
                    />
                  ))}
                  {lanes > 0 && (
                    <div className="pv-cal-ribbons" data-calendar-ribbons={week[0]!.key}>
                      {spans.map((span) => (
                        <button
                          key={span.card.id}
                          type="button"
                          className="pv-ribbon"
                          data-project-card={span.card.id}
                          data-continues-left={span.continuesLeft}
                          data-continues-right={span.continuesRight}
                          data-done={isProjectCardDone(span.card, properties)}
                          style={{
                            gridColumn: `${span.startCol + 1} / ${span.endCol + 2}`,
                            gridRow: span.lane + 1,
                            '--pv-card-color': span.color,
                          } as React.CSSProperties}
                          title={span.card.title}
                          onPointerDown={(event) => startCardDrag(event, span.card)}
                          onClick={() => props.onOpenCard(span.card.id)}
                        >
                          <span className="pv-ribbon-text">{span.card.title || t('project.board.untitled_card')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {selected && (
          <DayPanel
            dayKey={selected}
            roles={selectedRoles}
            properties={properties}
            colorOf={colorOf}
            descriptionFor={props.descriptionFor}
            onOpenCard={props.onOpenCard}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </ViewShell>
  )
}
function CalendarCell({ cell, mode, today, selected, dropping, cards, propertyId, properties, colorOf, keyOf, todayStamp, canEdit, onSelect, onOpenCard, onCardPointerDown, onQuickAdd }: {
  cell: Cell
  mode: ProjectCalendarMode
  today: boolean
  selected: boolean
  dropping: boolean
  cards: readonly ProjectCard[]
  propertyId: string | undefined
  properties: readonly ProjectProperty[]
  colorOf: (card: ProjectCard) => string
  keyOf: (stamp: number) => string
  todayStamp: number
  canEdit: boolean
  onSelect: () => void
  onOpenCard: (id: string) => void
  onCardPointerDown: (event: React.PointerEvent, card: ProjectCard) => void
  onQuickAdd: (day: Date) => Promise<void>
}): ReactElement {
  const chips = projectCalendarDayChips(cards, propertyId, cell.key, keyOf)
  const shown = mode === 'month' ? chips.slice(0, MAX_CHIPS) : chips
  const hidden = chips.length - shown.length
  const weekend = cell.date.getDay() === 0 || cell.date.getDay() === 6
  return (
    <div
      className="pv-cal-cell group"
      data-calendar-day={cell.key}
      data-outside={!cell.inMonth}
      data-today={today}
      data-selected={selected}
      data-weekend={weekend}
      data-drop={dropping}
    >
      <button type="button" className="pv-cal-hit" aria-label={cell.key} aria-pressed={selected} onClick={onSelect} />
      <span className="pv-cal-num relative z-[1]">{cell.day}</span>
      {canEdit && (cell.inMonth || mode !== 'month') && (
        <button
          type="button"
          aria-label={t('project.board.new_card')}
          className="absolute right-1 top-1 z-[3] rounded-[var(--r-xs)] p-0.5 text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(event) => { event.stopPropagation(); void onQuickAdd(cell.date) }}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      )}
      <div className="pv-cal-chips">
        {shown.map(({ card }) => {
          const days = projectCardDays(card, propertyId)!
          return (
            <button
              key={card.id}
              type="button"
              className="pv-cal-chip"
              data-project-card={card.id}
              data-start="true"
              data-done={isProjectCardDone(card, properties)}
              data-overdue={projectCalendarOverdue(card, properties, days.end, todayStamp)}
              style={{ '--pv-card-color': colorOf(card), touchAction: 'none' } as React.CSSProperties}
              onPointerDown={(event) => onCardPointerDown(event, card)}
              onClick={(event) => { event.stopPropagation(); onOpenCard(card.id) }}
            >
              {card.icon && <span aria-hidden="true">{card.icon}</span>}
              <span className="pv-cal-chip-text">{card.title || t('project.board.untitled_card')}</span>
            </button>
          )
        })}
        {hidden > 0 && (
          <button type="button" className="pv-cal-more" onClick={(event) => { event.stopPropagation(); onSelect() }}>
            {t('project.calendar.more', { count: hidden })}
          </button>
        )}
      </div>
    </div>
  )
}

/** The selected day in full: every card it touches, and whether it starts, ends or runs through it. */
function DayPanel({ dayKey, roles, properties, colorOf, descriptionFor, onOpenCard, onClose }: {
  dayKey: string
  roles: readonly { card: ProjectCard, role: string }[]
  properties: readonly ProjectProperty[]
  colorOf: (card: ProjectCard) => string
  descriptionFor?: (cardId: string) => string
  onOpenCard: (id: string) => void
  onClose: () => void
}): ReactElement {
  const locale = useLocale()
  const date = new Date(`${dayKey}T00:00:00`)
  const label = date.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' })
  const roleLabel: Record<string, string> = {
    start: t('project.calendar.role_start'),
    due: t('project.calendar.role_due'),
    both: t('project.calendar.role_both'),
    active: t('project.calendar.role_active'),
  }
  return (
    <aside className="pv-cal-panel" aria-label={t('project.calendar.day_panel')} data-calendar-panel={dayKey}>
      <div className="pv-cal-panel-head">
        <span className="pv-cal-panel-date">{label}</span>
        <span className="pv-head-count">{roles.length}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </div>
      <div className="pv-cal-panel-list pv-scroll">
        {roles.length === 0 && <p className="px-1 py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.calendar.day_empty')}</p>}
        {roles.map(({ card, role }) => {
          const description = descriptionFor?.(card.id) ?? ''
          return (
            <button
              key={card.id}
              type="button"
              className="pv-daycard"
              data-project-card={card.id}
              style={{ '--pv-card-color': colorOf(card) } as React.CSSProperties}
              onClick={() => onOpenCard(card.id)}
            >
              <span className="pv-daycard-top">
                <span className="pv-daycard-title">{card.icon && <span className="mr-1" aria-hidden="true">{card.icon}</span>}{card.title || t('project.board.untitled_card')}</span>
                <span className="pv-role" data-role={role}>{roleLabel[role]}</span>
              </span>
              {description && <span className="pv-daycard-desc">{description}</span>}
              <span className="pv-daycard-meta">
                {isProjectCardDone(card, properties) && <span className="text-[var(--success)]">{t('project.card.done_label')}</span>}
                <span>{dayKey}</span>
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
