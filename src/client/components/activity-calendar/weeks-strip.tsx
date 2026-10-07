import type { JSX, ReactNode } from 'react'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { ChevronDown, FileText } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Tooltip } from '../overlay'
import { type WeekCell } from './strip'
import { heatCell } from './heat-cell'

// A day with more notes than this gets a truncated list plus a way out. The panel below
// the week strip used to mount every note of the last-shown week and day forever, so a
// single busy day (a bulk import, a whole-vault restore) put thousands of buttons under a
// collapsed surface. 50 is a row-count budget, not a data limit: the day filter still
// shows all of them.
export const DAY_NOTE_LIMIT = 50

// `--dur-base` is 220ms and the collapse animates `grid-template-rows`, which needs its
// children present for the whole run; unmounting any earlier would snap the panel shut.
const REVEAL_UNMOUNT_MS = 240

interface WeeksStripProps {
  stripWeeks: WeekCell[][]
  expandedWeek: number | null
  shownWeek: number | null
  expandedDay: string | null
  shownDay: string | null
  isExpandedWeekNotes: boolean
  weekCells: WeekCell[] | undefined
  weekCellsTotal: number
  weekdayLabels: string[]
  flashRef: React.RefObject<HTMLDivElement | null>
  onStripWeekClick: (event: React.MouseEvent, weekIndex: number) => void
  onToggleDay: (key: string) => void
  onToggleWeekNotes: () => void
  onActivateDay: (key: string, diaryId: string | null) => void
  onNoteClick: (noteId: string) => void
  onJumpToDay: (key: string) => void
  isWeekRangeActive: (week: WeekCell[]) => boolean
  isLatestOutside: (key: string) => boolean
  gapLabel: (key: string) => string
  flaggedLabel: (key: string) => string
}

interface DayInteractions {
  expandedDay: string | null
  shownDay: string | null
  isLatestOutside: (key: string) => boolean
  gapLabel: (key: string) => string
  onActivateDay: (key: string, diaryId: string | null) => void
  onToggleDay: (key: string) => void
  onNoteClick: (noteId: string) => void
  onJumpToDay: (key: string) => void
}

function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), REVEAL_UNMOUNT_MS)
    return () => window.clearTimeout(timer)
  }, [open])
  return (
    <div className={cn('grid transition-[grid-template-rows] duration-[var(--dur-base)] ease-[var(--ease-out)]', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
      <div aria-hidden={!open} inert={!open} className='min-h-0 overflow-hidden'>
        {mounted ? children : null}
      </div>
    </div>
  )
}

function WeekHeatColumn({
  week,
  weekIndex,
  expandedWeek,
  isWeekRangeActive,
  isLatestOutside,
  flaggedLabel,
  onStripWeekClick,
}: {
  week: WeekCell[]
  weekIndex: number
  expandedWeek: number | null
  isWeekRangeActive: (week: WeekCell[]) => boolean
  isLatestOutside: (key: string) => boolean
  flaggedLabel: (key: string) => string
  onStripWeekClick: (event: React.MouseEvent, weekIndex: number) => void
}) {
  return (
    <button
      type='button'
      aria-expanded={expandedWeek === weekIndex}
      aria-current={isWeekRangeActive(week) ? 'true' : undefined}
      aria-label={t('sidebar.calendar_expand_week_value0', { value0: week[0]?.key.slice(5), value1: week[6]?.key.slice(5) })}
      onClick={(event) => onStripWeekClick(event, weekIndex)}
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-[var(--sp-0-5)] rounded-[var(--r-3)] p-px transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
        expandedWeek === weekIndex && 'bg-[var(--accent-soft)]',
      )}
    >
      {week.reduce((sum, cell) => sum + cell.count, 0) > 0 && (<span className='sr-only'>{t('sidebar.calendar_week_notes_value0', { value0: week.reduce((sum, cell) => sum + cell.count, 0) })}</span>)}
      {week.map((cell) => (
        <Tooltip key={cell.key} label={flaggedLabel(cell.key)}>
          <span
            aria-hidden='true'
            className={cn(
              'aspect-square w-full rounded-[var(--r-2)]',
              cell.today && 'ring-1 ring-inset ring-[var(--accent)]',
              cell.selected && !cell.today && 'ring-1 ring-inset ring-[var(--accent)]/70',
              isLatestOutside(cell.key) && 'border border-dashed border-[var(--accent)]/80',
            )}
            style={heatCell(cell.level)}
          />
        </Tooltip>
      ))}
    </button>
  )
}

function WeekHeatStrip({
  stripWeeks,
  expandedWeek,
  isWeekRangeActive,
  isLatestOutside,
  flaggedLabel,
  onStripWeekClick,
}: {
  stripWeeks: WeekCell[][]
  expandedWeek: number | null
  isWeekRangeActive: (week: WeekCell[]) => boolean
  isLatestOutside: (key: string) => boolean
  flaggedLabel: (key: string) => string
  onStripWeekClick: (event: React.MouseEvent, weekIndex: number) => void
}) {
  return (
    <>
      <div className='px-[var(--sp-0-5)] pb-[var(--sp-1)] text-[length:var(--text-9)] font-medium text-[var(--text-quaternary)]'>
        {t('sidebar.calendar_week_strip_value0', { value0: stripWeeks.length })}
      </div>
      <div className='flex gap-[var(--sp-0-5)]'>
        {stripWeeks.map((week, weekIndex) => (
          <WeekHeatColumn
            key={weekIndex}
            week={week}
            weekIndex={weekIndex}
            expandedWeek={expandedWeek}
            isWeekRangeActive={isWeekRangeActive}
            isLatestOutside={isLatestOutside}
            flaggedLabel={flaggedLabel}
            onStripWeekClick={onStripWeekClick}
          />
        ))}
      </div>
    </>
  )
}

function DayNoteOverflow({ total, className, onShowAll }: { total: number; className: string; onShowAll: () => void }) {
  const label = t('sidebar.calendar_show_day_all_value0', { value0: total })
  if (total <= DAY_NOTE_LIMIT)
    return null
  return (
    <button
      type='button'
      aria-label={label}
      onClick={onShowAll}
      className={cn('flex h-[var(--sp-6)] w-full items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]', className)}
    >
      <ChevronDown size={9} className='shrink-0 text-[var(--text-quaternary)]' />
      <span className='min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--accent)]'>{label}</span>
    </button>
  )
}

function WeekNotesList({
  cell,
  weekdayLabel,
  dayNumber,
  onJumpToDay,
  onNoteClick,
}: {
  cell: WeekCell
  weekdayLabel: string
  dayNumber: string
  onJumpToDay: (key: string) => void
  onNoteClick: (noteId: string) => void
}) {
  return (
    <div>
      <button
        type='button'
        aria-label={t('sidebar.calendar_jump_to_day')}
        onClick={() => onJumpToDay(cell.key)}
        className='flex w-full items-center gap-[var(--sp-1)] rounded-[var(--r-sm)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] text-left text-[length:var(--text-9-5)] font-medium text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
      >
        <span>{weekdayLabel}</span>
        <span className='tabular'>{dayNumber}</span>
        <span className='ml-auto tabular'>{cell.notes.length}</span>
      </button>
      {cell.notes.slice(0, DAY_NOTE_LIMIT).map((note) => (
        <button
          key={note.id}
          type='button'
          onClick={() => onNoteClick(note.id)}
          className='flex h-[var(--sp-6)] w-full items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] py-[var(--sp-0-5)] pr-[var(--sp-1-5)] pl-[var(--sp-5)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
        >
          <FileText size={9} className='shrink-0 text-[var(--text-quaternary)]' />
          <span className='min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-secondary)]'>{note.title}</span>
        </button>
      ))}
      <DayNoteOverflow total={cell.notes.length} className="py-[var(--sp-0-5)] pr-[var(--sp-1-5)] pl-[var(--sp-5)]" onShowAll={() => onJumpToDay(cell.key)} />
    </div>
  )
}

function WeekNotesBlock({
  weekCells,
  weekCellsTotal,
  weekdayLabels,
  isExpandedWeekNotes,
  onToggleWeekNotes,
  onJumpToDay,
  onNoteClick,
}: {
  weekCells: WeekCell[]
  weekCellsTotal: number
  weekdayLabels: string[]
  isExpandedWeekNotes: boolean
  onToggleWeekNotes: () => void
  onJumpToDay: (key: string) => void
  onNoteClick: (noteId: string) => void
}) {
  return (
    <>
      <div className='my-[var(--sp-0-5)] border-t border-[var(--border-subtle)]' />
      <button
        type='button'
        aria-expanded={isExpandedWeekNotes}
        aria-label={t('sidebar.calendar_week_notes_value0', { value0: weekCellsTotal })}
        onClick={onToggleWeekNotes}
        className='flex h-[var(--sp-6)] min-w-0 flex-1 items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] px-[var(--sp-1-5)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
      >
        <FileText size={10} className='shrink-0 text-[var(--text-quaternary)]' />
        <span className='text-[length:var(--text-10-5)] text-[var(--text-secondary)]'>
          {t('sidebar.calendar_week_notes_value0', { value0: weekCellsTotal })}
        </span>
        <ChevronDown size={10} className={cn('ml-auto text-[var(--text-quaternary)] transition-transform duration-[var(--dur-fast)]', isExpandedWeekNotes && 'rotate-180')} />
      </button>
      <Reveal open={isExpandedWeekNotes}>
        <div className='space-y-1 py-[var(--sp-0-5)]'>
          {weekCells.map((cell, dayIndex) =>
            cell.notes.length > 0 ? (
              <WeekNotesList
                key={cell.key}
                cell={cell}
                weekdayLabel={weekdayLabels[dayIndex]}
                dayNumber={cell.key.slice(5)}
                onJumpToDay={onJumpToDay}
                onNoteClick={onNoteClick}
              />
            ) : null,
          )}
        </div>
      </Reveal>
    </>
  )
}

function DayNotesList({ cell, ix }: { cell: WeekCell; ix: DayInteractions }) {
  return (
    <Reveal open={ix.expandedDay === cell.key}>
      <div className='space-y-px py-[var(--sp-0-5)] pl-[var(--sp-3-5)] pr-[var(--sp-1)]'>
        {ix.shownDay === cell.key &&
          cell.notes.slice(0, DAY_NOTE_LIMIT).map((note) => (
            <button
              key={note.id}
              type='button'
              onClick={() => ix.onNoteClick(note.id)}
              className='flex h-[var(--sp-6)] w-full items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] px-[var(--sp-1-5)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
            >
              <FileText size={9} className='shrink-0 text-[var(--text-quaternary)]' />
              <span className='min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-secondary)]'>{note.title}</span>
            </button>
          ))}
        {ix.shownDay === cell.key && <DayNoteOverflow total={cell.notes.length} className='px-[var(--sp-1-5)]' onShowAll={() => ix.onJumpToDay(cell.key)} />}
      </div>
    </Reveal>
  )
}

function DayHeaderRow({ cell, dayIndex, weekdayLabels, ix }: { cell: WeekCell; dayIndex: number; weekdayLabels: string[]; ix: DayInteractions }) {
  const hasNotes = cell.notes.length > 0
  const isLatest = ix.isLatestOutside(cell.key)
  const expanded = ix.expandedDay === cell.key
  return (
    <>
      <div className='flex items-center gap-[var(--sp-0-5)]'>
        <button
          type='button'
          aria-label={ix.gapLabel(cell.key)}
          onClick={() => ix.onActivateDay(cell.key, cell.diaryId)}
          className={cn(
            'flex h-[var(--sp-6)] min-w-0 flex-1 items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] px-[var(--sp-1-5)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
            cell.selected && 'bg-[var(--accent-soft)]',
            isLatest && 'border border-dashed border-[var(--accent)]/80',
          )}
        >
          <span className='w-[var(--sp-3)] shrink-0 text-center text-[length:var(--text-9-5)] font-medium text-[var(--text-quaternary)]'>{weekdayLabels[dayIndex]}</span>
          <span className='shrink-0 text-[length:var(--text-10-5)] tabular text-[var(--text-secondary)]'>{cell.key.slice(5)}</span>
          {cell.today && <span aria-hidden='true' className='size-1.25 shrink-0 rounded-full bg-[var(--accent)]' />}
          <span className='ml-auto flex min-w-0 shrink-0 items-center gap-[var(--sp-1-5)]'>
            {cell.diaryId && (
              <span className='inline-flex items-center gap-[var(--sp-1)] rounded-full bg-[var(--accent-soft)] px-[var(--sp-1-5)] py-px text-[length:var(--text-9)] font-medium text-[var(--accent)]'>
                <span aria-hidden='true' className='size-0.75 rounded-full bg-[var(--accent)]' />
                {t('sidebar.diary_tag')}
              </span>
            )}
            {cell.count > 0 && <span className='text-[length:var(--text-9-5)] tabular text-[var(--text-quaternary)]'>{cell.count}</span>}
          </span>
        </button>
        {hasNotes && (
          <button
            type='button'
            aria-expanded={expanded}
            aria-label={t('sidebar.calendar_expand_day')}
            onClick={() => ix.onToggleDay(cell.key)}
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
              expanded && 'text-[var(--text-secondary)]',
            )}
          >
            <ChevronDown size={10} className={cn('transition-transform duration-[var(--dur-fast)]', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      <DayNotesList cell={cell} ix={ix} />
    </>
  )
}

function ExpandedDayRow({ cell, dayIndex, weekdayLabels, ix }: { cell: WeekCell; dayIndex: number; weekdayLabels: string[]; ix: DayInteractions }) {
  return (
    <div>
      <DayHeaderRow cell={cell} dayIndex={dayIndex} weekdayLabels={weekdayLabels} ix={ix} />
    </div>
  )
}

function ExpandedWeekPanel(props: WeeksStripProps) {
  const shownCells = props.shownWeek !== null ? props.stripWeeks[props.shownWeek] : undefined
  const ix: DayInteractions = {
    expandedDay: props.expandedDay,
    shownDay: props.shownDay,
    isLatestOutside: props.isLatestOutside,
    gapLabel: props.gapLabel,
    onActivateDay: props.onActivateDay,
    onToggleDay: props.onToggleDay,
    onNoteClick: props.onNoteClick,
    onJumpToDay: props.onJumpToDay,
  }
  return (
    <Reveal open={props.expandedWeek !== null}>
      <div className='mt-[var(--sp-1-5)] space-y-px rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-1)]'>
        {shownCells && (
          <div>
            {shownCells.map((cell, dayIndex) => (
              <ExpandedDayRow key={cell.key} cell={cell} dayIndex={dayIndex} weekdayLabels={props.weekdayLabels} ix={ix} />
            ))}
          </div>
        )}
        {props.weekCellsTotal > 0 && props.weekCells && (
          <WeekNotesBlock
            weekCells={props.weekCells}
            weekCellsTotal={props.weekCellsTotal}
            weekdayLabels={props.weekdayLabels}
            isExpandedWeekNotes={props.isExpandedWeekNotes}
            onToggleWeekNotes={props.onToggleWeekNotes}
            onJumpToDay={props.onJumpToDay}
            onNoteClick={props.onNoteClick}
          />
        )}
      </div>
    </Reveal>
  )
}

export function WeeksStrip(props: WeeksStripProps): JSX.Element {
  return (
    <div ref={props.flashRef} className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'>
      <WeekHeatStrip
        stripWeeks={props.stripWeeks}
        expandedWeek={props.expandedWeek}
        isWeekRangeActive={props.isWeekRangeActive}
        isLatestOutside={props.isLatestOutside}
        flaggedLabel={props.flaggedLabel}
        onStripWeekClick={props.onStripWeekClick}
      />
      <ExpandedWeekPanel {...props} />
    </div>
  )
}
