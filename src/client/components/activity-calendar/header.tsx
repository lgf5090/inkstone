import type { JSX, ReactNode } from 'react'
import { BarChart3, CalendarCheck, CalendarDays, CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react'
import { t } from '../../lib/i18n'
import { IconButton } from '../primitives'
import { Tooltip } from '../overlay'

type CalendarView = 'month' | 'weeks' | 'year'

interface CalendarHeaderProps {
  view: CalendarView
  onViewChange: (view: CalendarView) => void
  isCurrentMonth: boolean
  isCurrentYear: boolean
  shiftMonth: (delta: number) => void
  shiftYear: (delta: number) => void
  jumpToCurrentMonth: () => void
  jumpToCurrentYear: () => void
}

function NavStepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label} side='bottom'>
      <IconButton label={label} size='sm' onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  )
}

function MonthNav({
  isCurrentMonth,
  shiftMonth,
  jumpToCurrentMonth,
}: {
  isCurrentMonth: boolean
  shiftMonth: (delta: number) => void
  jumpToCurrentMonth: () => void
}) {
  return (
    <>
      {!isCurrentMonth && (
        <NavStepButton label={t('sidebar.calendar_this_month')} onClick={jumpToCurrentMonth}>
          <CalendarCheck size={13} />
        </NavStepButton>
      )}
      <NavStepButton label={t('sidebar.calendar_prev_month')} onClick={() => shiftMonth(-1)}>
        <ChevronLeft size={13} />
      </NavStepButton>
      <NavStepButton label={t('sidebar.calendar_next_month')} onClick={() => shiftMonth(1)}>
        <ChevronRight size={13} />
      </NavStepButton>
    </>
  )
}

function YearNav({
  isCurrentYear,
  shiftYear,
  jumpToCurrentYear,
}: {
  isCurrentYear: boolean
  shiftYear: (delta: number) => void
  jumpToCurrentYear: () => void
}) {
  return (
    <>
      {!isCurrentYear && (
        <NavStepButton label={t('sidebar.calendar_this_year')} onClick={jumpToCurrentYear}>
          <CalendarCheck size={13} />
        </NavStepButton>
      )}
      <NavStepButton label={t('sidebar.calendar_prev_year')} onClick={() => shiftYear(-1)}>
        <ChevronLeft size={13} />
      </NavStepButton>
      <NavStepButton label={t('sidebar.calendar_next_year')} onClick={() => shiftYear(1)}>
        <ChevronRight size={13} />
      </NavStepButton>
    </>
  )
}

function ViewModeButton({
  view,
  active,
  label,
  icon,
  onSelect,
}: {
  view: CalendarView
  active: boolean
  label: string
  icon: ReactNode
  onSelect: (view: CalendarView) => void
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={() => onSelect(view)}
      className={`flex h-[var(--sp-6)] min-w-0 items-center gap-[var(--sp-0-5)] whitespace-nowrap border-l border-[var(--border-default)] px-[var(--sp-1-5)] text-[length:var(--text-10-5)] font-medium transition-colors first:border-l-0 aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent)]`}
    >
      {icon}
      <span className='truncate'>{label}</span>
    </button>
  )
}

function ViewSwitcher({
  view,
  onViewChange,
}: {
  view: CalendarView
  onViewChange: (view: CalendarView) => void
}) {
  return (
    <div role='group' aria-label={t('sidebar.calendar_view')} className='flex overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-default)]'>
      <ViewModeButton view='month' active={view === 'month'} label={t('sidebar.calendar_month_view')} icon={<CalendarDays size={10} className='shrink-0' />} onSelect={onViewChange} />
      <ViewModeButton view='weeks' active={view === 'weeks'} label={t('sidebar.calendar_week_view')} icon={<BarChart3 size={10} className='shrink-0' />} onSelect={onViewChange} />
      <ViewModeButton view='year' active={view === 'year'} label={t('sidebar.calendar_year_view')} icon={<CalendarRange size={10} className='shrink-0' />} onSelect={onViewChange} />
    </div>
  )
}

export function CalendarHeader({
  view,
  onViewChange,
  isCurrentMonth,
  isCurrentYear,
  shiftMonth,
  shiftYear,
  jumpToCurrentMonth,
  jumpToCurrentYear,
}: CalendarHeaderProps): JSX.Element {
  return (
    <div className='mt-[var(--sp-1)] flex items-center justify-between gap-[var(--sp-1)] px-[var(--sp-0-5)]'>
      <div className='flex items-center gap-[var(--sp-0-5)]'>
        {view === 'month' && (
          <MonthNav isCurrentMonth={isCurrentMonth} shiftMonth={shiftMonth} jumpToCurrentMonth={jumpToCurrentMonth} />
        )}
        {view === 'year' && (
          <YearNav isCurrentYear={isCurrentYear} shiftYear={shiftYear} jumpToCurrentYear={jumpToCurrentYear} />
        )}
      </div>
      <ViewSwitcher view={view} onViewChange={onViewChange} />
    </div>
  )
}
