import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { Segmented, Input } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { DatePicker } from '../../../../components/date-picker'
import { Button } from '../../../../components/primitives'
import { useLocale } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import {
  addDuration,
  type CalendarSystem,
  difference,
  formatDate,
  formatDuration,
  subtractDuration,
  todayIso,
} from '@shared/tools/calculator/converters/date-calculator'
import { calcT } from '../lib/calc-i18n'
import { copyToClipboard } from '../lib/clipboard'

export function DateView() {
  const locale = useLocale()
  const [mode, setMode] = useState<'difference' | 'offset'>('difference')
  const [from, setFrom] = useState(todayIso())
  const [to, setTo] = useState(todayIso())
  const [start, setStart] = useState(todayIso())
  const [duration, setDuration] = useState({ years: '0', months: '0', days: '0' })
  const [direction, setDirection] = useState<'add' | 'subtract'>('add')
  const [calendar, setCalendar] = useState<CalendarSystem>('gregory')

  const diff = useMemo(() => difference(from, to, calendar), [from, to, calendar])
  const resultDate = useMemo(() => {
    const years = Number(duration.years) || 0
    const months = Number(duration.months) || 0
    const days = Number(duration.days) || 0
    return direction === 'add' ? addDuration(start, years, months, days, calendar) : subtractDuration(start, years, months, days, calendar)
  }, [start, duration, direction, calendar])

  const copy = (text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) useUi.getState().toast({ title: calcT('tools.calculator.error.invalid_input'), tone: 'danger' })
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-y-auto p-3 sm:p-6">
      <div className="w-full max-w-[620px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">{calcT('tools.calculator.date.title')}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={mode}
              onChange={setMode}
              size="sm"
              label={calcT('tools.calculator.date.title')}
              options={[
                { value: 'difference', label: calcT('tools.calculator.date.difference') },
                { value: 'offset', label: calcT('tools.calculator.date.add_subtract') },
              ]}
            />
            <SelectMenu
              label={calcT('tools.calculator.date.calendar')}
              value={calendar}
              size="sm"
              width={220}
              onChange={(value) => setCalendar(value as CalendarSystem)}
              options={[
                { value: 'gregory', label: calcT('tools.calculator.date.calendar.gregory') },
                { value: 'japanese', label: calcT('tools.calculator.date.calendar.japanese') },
                { value: 'islamic-umalqura', label: calcT('tools.calculator.date.calendar.islamic_umalqura') },
              ]}
            />
          </div>
        </div>

        {mode === 'difference' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{calcT('tools.calculator.date.from')}</span>
                <DatePicker label={calcT('tools.calculator.date.from')} value={from} onChange={setFrom} />
              </label>
              <label className="space-y-1">
                <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{calcT('tools.calculator.date.to')}</span>
                <DatePicker label={calcT('tools.calculator.date.to')} value={to} onChange={setTo} />
              </label>
            </div>
            <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
              <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{calcT('tools.calculator.date.result')}</div>
              <div className="mt-1 text-[length:var(--text-20)] font-semibold text-[var(--text-primary)]">
                {diff ? (diff.sameDate ? calcT('tools.calculator.date.same_date') : formatDuration(diff.years, diff.months, diff.days, locale)) : calcT('tools.calculator.date.out_of_bounds')}
              </div>
              {diff && (
                <div className="mt-2 flex items-center justify-between gap-3 text-[length:var(--text-13)] text-[var(--text-secondary)]">
                  <span>{calcT('tools.calculator.date.total_days')}: <strong className="tabular-nums text-[var(--text-primary)]">{diff.totalDays}</strong></span>
                  <Button size="sm" icon={<Copy size={13} />} onClick={() => copy(String(diff.totalDays))}>{calcT('tools.calculator.common.copy')}</Button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{calcT('tools.calculator.date.start')}</span>
              <DatePicker label={calcT('tools.calculator.date.start')} value={start} onChange={setStart} />
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['years', 'months', 'days'] as const).map((key) => (
                <label key={key} className="space-y-1">
                  <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{calcT(`tools.calculator.date.${key}`)}</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={duration[key]}
                    onChange={(event) => setDuration((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <Segmented
              value={direction}
              onChange={setDirection}
              size="sm"
              label={calcT('tools.calculator.date.add_subtract')}
              options={[
                { value: 'add', label: calcT('tools.calculator.date.add') },
                { value: 'subtract', label: calcT('tools.calculator.date.subtract') },
              ]}
            />
            <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
              <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{calcT('tools.calculator.date.result')}</div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-[length:var(--text-20)] font-semibold text-[var(--text-primary)]">
                  {resultDate ? formatDate(resultDate, locale, calendar) : calcT('tools.calculator.date.out_of_bounds')}
                </span>
                {resultDate && (
                  <Button size="sm" icon={<Copy size={13} />} onClick={() => copy(resultDate)}>{calcT('tools.calculator.common.copy')}</Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
