/**
 * A small "find a time" board: busy blocks from every selected calendar, and the open slots
 * between 09:00 and 18:00 the reader can start an event in.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarCheck } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { CalendarBusyBlock, CalendarDto } from '@shared/calendar/model'
import { t, localeTag } from '../../lib/i18n'
import { addDaysKey, dateKey, parseDateKey } from '../../lib/time'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Checkbox, Field, Select } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import * as api from './api'

const WORK_START_HOUR = 9
const WORK_END_HOUR = 18
const MIN_SLOT_MINUTES = 30

interface Slot {
  startMs: number
  endMs: number
  label: string
}

function slotsForDay(key: string, zone: string, busy: readonly CalendarBusyBlock[]): Slot[] {
  const day = Temporal.PlainDate.from(key).toZonedDateTime(zone)
  const windowStart = day.add({ hours: WORK_START_HOUR })
  const windowEnd = day.add({ hours: WORK_END_HOUR })
  const startMs = windowStart.epochMilliseconds
  const endMs = windowEnd.epochMilliseconds
  const clipped = busy
    .map(block => ({ startMs: Math.max(block.startMs, startMs), endMs: Math.min(block.endMs, endMs) }))
    .filter(block => block.endMs > block.startMs && block.endMs > startMs && block.startMs < endMs)
    .sort((left, right) => left.startMs - right.startMs)
  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const block of clipped) {
    const last = merged.at(-1)
    if (last && block.startMs <= last.endMs) last.endMs = Math.max(last.endMs, block.endMs)
    else merged.push({ ...block })
  }
  const slots: Slot[] = []
  let cursor = startMs
  const push = (from: number, to: number): void => {
    if (to - from < MIN_SLOT_MINUTES * 60_000) return
    const start = Temporal.Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(zone)
    const end = Temporal.Instant.fromEpochMilliseconds(to).toZonedDateTimeISO(zone)
    slots.push({
      startMs: from,
      endMs: to,
      label: `${start.toPlainTime().toString({ smallestUnit: 'minute' })}–${end.toPlainTime().toString({ smallestUnit: 'minute' })}`,
    })
  }
  for (const block of merged) {
    push(cursor, block.startMs)
    cursor = Math.max(cursor, block.endMs)
  }
  push(cursor, endMs)
  return slots
}

export function CalendarFreeBusyDialog({
  open,
  calendars,
  timeZone,
  initialDate,
  onClose,
  onPick,
}: {
  open: boolean
  calendars: readonly CalendarDto[]
  timeZone: string
  initialDate: Date
  onClose: () => void
  onPick?: (start: Date, end: Date) => void
}) {
  const [startKey, setStartKey] = useState(() => dateKey(initialDate))
  const [days, setDays] = useState(7)
  const [selected, setSelected] = useState<string[]>(() => calendars.map(calendar => calendar.id))
  const [busy, setBusy] = useState<CalendarBusyBlock[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelected(calendars.map(calendar => calendar.id))
  }, [open, calendars])

  useEffect(() => {
    if (!open) return
    if (selected.length === 0) {
      setBusy([])
      setTruncated(false)
      setLoading(false)
      setError(null)
      return
    }
    const from = parseDateKey(startKey)
    const to = parseDateKey(addDaysKey(startKey, days))
    from.setHours(0, 0, 0, 0)
    to.setHours(0, 0, 0, 0)
    let cancelled = false
    setLoading(true)
    setError(null)
    void api.getFreeBusy({ from: from.getTime(), to: to.getTime(), calendarIds: selected })
      .then((answer) => {
        if (cancelled) return
        setBusy(answer.busy)
        setTruncated(answer.truncated)
      }, (cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error && cause.message ? cause.message : t('calendar.free_busy.failed'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, startKey, days, selected])

  const daysToShow = useMemo(
    () => Array.from({ length: days }, (_, index) => addDaysKey(startKey, index)),
    [startKey, days],
  )

  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.free_busy.title')}
      description={t('calendar.free_busy.description')}
      width={640}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3 pt-1">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('calendar.free_busy.from')}>
            <DatePicker
              label={t('calendar.free_busy.from')}
              value={startKey}
              onChange={(next) => { if (next) setStartKey(next) }}
            />
          </Field>
          <Field label={t('calendar.free_busy.days')}>
            <Select
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
              aria-label={t('calendar.free_busy.days')}
            >
              <option value="3">{t('calendar.free_busy.days_n', { count: 3 })}</option>
              <option value="5">{t('calendar.free_busy.days_n', { count: 5 })}</option>
              <option value="7">{t('calendar.free_busy.days_n', { count: 7 })}</option>
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('calendar.free_busy.calendars')}
          </legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {calendars.map(calendar => (
              <Checkbox
                key={calendar.id}
                checked={selected.includes(calendar.id)}
                onChange={(checked) => toggle(calendar.id, checked)}
                label={(
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: calendar.color }} aria-hidden="true" />
                    <span>{calendar.name}</span>
                  </span>
                )}
              />
            ))}
          </div>
        </fieldset>
        {loading && <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>}
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {!loading && !error && (
          <div className="max-h-[45vh] space-y-2 overflow-y-auto">
            {truncated && (
              <p role="status" className="text-[length:var(--text-11)] text-[var(--warning)]">{t('calendar.free_busy.truncated')}</p>
            )}
            {daysToShow.map((key) => {
              const slots = slotsForDay(key, timeZone, busy)
              const label = new Intl.DateTimeFormat(localeTag(), {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                timeZone,
              }).format(new Date(Temporal.PlainDate.from(key).toZonedDateTime(timeZone).add({ hours: 12 }).epochMilliseconds))
              return (
                <div key={key} className="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 py-2">
                  <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{label}</p>
                  {slots.length === 0
                    ? <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('calendar.free_busy.full')}</p>
                    : (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {slots.map(slot => (
                            <button
                              key={slot.startMs}
                              type="button"
                              onClick={() => {
                                if (!onPick) return
                                onPick(new Date(slot.startMs), new Date(Math.min(slot.endMs, slot.startMs + 60 * 60_000)))
                                onClose()
                              }}
                              className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-raised)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                            >
                              <CalendarCheck size={11} aria-hidden="true" />
                              {slot.label}
                            </button>
                          ))}
                        </div>
                      )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
