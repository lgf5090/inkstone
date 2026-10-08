import { Fragment, useMemo, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { t } from '../lib/i18n'
import { dateKey, type WeekStartDay } from '../lib/time'


export interface MonthGridCell {
  key: string
  day: number
  inMonth: boolean
  today: boolean
  date: Date
}

export function buildMonthGridCells(year: number, month: number, weekStart: WeekStartDay, todayKey?: string): MonthGridCell[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const offset = (new Date(year, month, 1).getDay() - weekStart + 7) % 7
  const rows = Math.ceil((offset + daysInMonth) / 7)
  const out: MonthGridCell[] = []
  for (let index = 0; index < rows * 7; index++) {
    const day = index - offset + 1
    const inMonth = day >= 1 && day <= daysInMonth
    const date = new Date(year, month, day)
    out.push({ key: dateKey(date), day: date.getDate(), inMonth, today: dateKey(date) === todayKey, date })
  }
  return out
}


interface MonthGridProps {
  year: number
  month: number
  weekStart?: WeekStartDay
  weekdayLabels: readonly string[]
  todayKey?: string
  className?: string
  ariaLabel?: string
  onKeyDown?: React.KeyboardEventHandler
  onMouseDown?: React.MouseEventHandler
  onMouseUp?: React.MouseEventHandler
  onMouseOver?: React.MouseEventHandler
  renderCell: (cell: MonthGridCell) => ReactNode
  /** Draws one extra column ahead of each week row — the week number, or anything else a row owns. */
  renderRowHeader?: (rowIndex: number, row: readonly MonthGridCell[]) => ReactNode
}

export function MonthGrid({ year, month, weekStart = 1, weekdayLabels, todayKey, className, ariaLabel, onKeyDown, onMouseDown, onMouseUp, onMouseOver, renderCell, renderRowHeader }: MonthGridProps) {
  const cells = useMemo(() => buildMonthGridCells(year, month, weekStart, todayKey), [year, month, weekStart, todayKey])
  const rows = useMemo(() => {
    const out: MonthGridCell[][] = []
    for (let index = 0; index < cells.length; index += 7)
      out.push(cells.slice(index, index + 7))
    return out
  }, [cells])
  return (<div role='group' aria-label={ariaLabel} onKeyDown={onKeyDown} onMouseDown={onMouseDown} onMouseUp={onMouseUp} onMouseOver={onMouseOver} className={cn('grid gap-[var(--sp-0-5)] select-none', renderRowHeader ? 'grid-cols-[var(--sp-4)_repeat(7,minmax(0,1fr))]' : 'grid-cols-7', className)}>
    {renderRowHeader && (<div aria-hidden='true' className='flex items-center justify-center text-[length:var(--text-8-5)] font-medium text-[var(--text-quaternary)]'>{t('sidebar.calendar_week_column_header')}</div>)}
    {weekdayLabels.map((label, index) => (<div key={index} className='flex items-center justify-center text-[length:var(--text-9)] font-medium text-[var(--text-quaternary)]'>
      {label}
    </div>))}
    {rows.map((row, rowIndex) => (<Fragment key={row[0]!.key}>
      {renderRowHeader?.(rowIndex, row)}
      {row.map((cell) => (<Fragment key={cell.key}>{renderCell(cell)}</Fragment>))}
    </Fragment>))}
  </div>)
}


export interface YearGridMonth {
  month: number
  cells: MonthGridCell[]
}

export function buildYearGridMonths(year: number, weekStart: WeekStartDay, todayKey?: string): YearGridMonth[] {
  return Array.from({ length: 12 }, (_, month) => ({ month, cells: buildMonthGridCells(year, month, weekStart, todayKey) }))
}

export const YEAR_GRID_COLUMNS = 3
export type YearGridColumns = 3 | 4
export type YearGridColumnsPref = 'auto' | '3' | '4'

export function yearGridColumns(width: number): YearGridColumns {
  return width >= 300 ? 4 : 3
}


interface YearGridProps {
  year: number
  weekStart?: WeekStartDay
  todayKey?: string
  columns?: YearGridColumns
  className?: string
  ariaLabel?: string
  onKeyDown?: React.KeyboardEventHandler
  renderMonth: (month: YearGridMonth) => ReactNode
}

export function YearGrid({ year, weekStart = 1, todayKey, columns = YEAR_GRID_COLUMNS, className, ariaLabel, onKeyDown, renderMonth }: YearGridProps) {
  const months = useMemo(() => buildYearGridMonths(year, weekStart, todayKey), [year, weekStart, todayKey])
  return (<div role='group' aria-label={ariaLabel} onKeyDown={onKeyDown} className={cn('grid gap-[var(--sp-1)] select-none', columns === 4 ? 'grid-cols-4' : 'grid-cols-3', className)}>
    {months.map((month) => (<Fragment key={month.month}>{renderMonth(month)}</Fragment>))}
  </div>)
}