/**
 * The create-event form used by a double-click on empty grid space.
 *
 * DayFlow's own double-click creates a row before the reader has typed anything, and closing the
 * editor leaves that empty event behind. This form is the draft: nothing is written until Create,
 * and Cancel really cancels. The wall clock is interpreted in the account's time zone, not the
 * browser's, so a calendar read in Shanghai behaves the same on a laptop in Berlin.
 */
import { useEffect, useState } from 'react'
import { Temporal } from 'temporal-polyfill'
import type { CalendarDto, CalendarResourceDto, CalendarTemplateDto } from '@shared/calendar/model'
import { MAX_EVENT_DESCRIPTION, MAX_EVENT_TITLE } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Checkbox, Field, Input, Segmented, Select, Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'

export interface NewCalendarEvent {
  title: string
  start: Temporal.ZonedDateTime
  end: Temporal.ZonedDateTime
  allDay: boolean
  startDate: Temporal.PlainDate
  endDate: Temporal.PlainDate
  calendarId: string
  resourceId: string | null
  description: string
  location: string
  color: string | null
}

interface CalendarEventDialogProps {
  open: boolean
  /** The instant the grid reported; its wall clock is read in `timeZone`. */
  initialStart: Date
  timeZone: string
  calendars: readonly CalendarDto[]
  resources?: readonly CalendarResourceDto[]
  defaultCalendarId?: string
  /** A reusable draft; its fields seed the form and the dates still come from the grid. */
  template?: CalendarTemplateDto | null
  onClose: () => void
  onCreate: (event: NewCalendarEvent) => void
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function wall(instant: Date): { date: string; time: string } {
  const date = new Date(instant)
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

function addMinutes(date: string, time: string, minutes: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const value = new Date(year!, month! - 1, day!, hour!, minute! + minutes)
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function wallDate(date: string, time: string, timeZone: string): Temporal.ZonedDateTime {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
  })
}

export function CalendarEventDialog({
  open,
  initialStart,
  timeZone,
  calendars,
  resources = [],
  defaultCalendarId,
  template,
  onClose,
  onCreate,
}: CalendarEventDialogProps) {
  const writable = calendars.filter(calendar => !calendar.readOnly)
  const [title, setTitle] = useState('')
  const [block, setBlock] = useState<'event' | 'focus' | 'ooo'>('event')
  const [allDay, setAllDay] = useState(false)
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('09:00')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('10:00')
  const [calendarId, setCalendarId] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const available = calendars.filter(calendar => !calendar.readOnly)
    const parts = wall(initialStart)
    const startClock = template ? '09:00' : parts.time === '00:00' ? '09:00' : parts.time
    const end = template?.allDay
      ? `${parts.date}T09:00`
      : addMinutes(parts.date, startClock, Math.max(5, template?.durationMinutes ?? 60))
    const [endDay, endClock] = end.split('T')
    setTitle(template?.title ?? '')
    setBlock('event')
    setAllDay(template?.allDay ?? false)
    setDate(parts.date)
    setStartTime(startClock)
    setEndDate(endDay ?? parts.date)
    setEndTime(endClock ?? '10:00')
    setColor(template?.color ?? null)
    setResourceId('')
    setCalendarId(
      available.find(calendar => calendar.isDefault)?.id
      ?? available.find(calendar => calendar.id === defaultCalendarId)?.id
      ?? available[0]?.id
      ?? '',
    )
    setDescription(template?.description ?? '')
    setLocation('')
    setError(null)
  }, [open, initialStart, defaultCalendarId, timeZone, calendars, template])

  const submit = (): void => {
    if (!calendarId) {
      setError(t('calendar.event.no_writable_calendar'))
      return
    }
    if (!allDay && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime))) {
      setError(t('calendar.event.invalid_time'))
      return
    }
    try {
      if (allDay) {
        const startDate = Temporal.PlainDate.from(date)
        const end = Temporal.PlainDate.from(endDate || date)
        if (Temporal.PlainDate.compare(end, startDate) < 0) {
          setError(t('calendar.event.end_before_start'))
          return
        }
        onCreate({
          title: title.trim() || t('calendar.event.untitled'),
          start: wallDate(date, '00:00', timeZone),
          end: wallDate(endDate || date, '00:00', timeZone),
          allDay: true,
          startDate,
          endDate: end,
          calendarId,
          resourceId: resourceId || null,
          description: description.trim(),
          location: location.trim(),
          color,
        })
        return
      }
      const start = wallDate(date, startTime, timeZone)
      const end = wallDate(endDate || date, endTime, timeZone)
      if (Temporal.ZonedDateTime.compare(end, start) <= 0) {
        setError(t('calendar.event.end_before_start'))
        return
      }
      onCreate({
        title: title.trim() || t('calendar.event.untitled'),
        start,
        end,
        allDay: false,
        startDate: start.toPlainDate(),
        endDate: end.toPlainDate(),
        calendarId,
        resourceId: resourceId || null,
        description: description.trim(),
        location: location.trim(),
        color,
      })
    } catch {
      setError(t('calendar.event.create_failed'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.event.new')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={writable.length === 0}>
            {t('calendar.event.create')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 pt-1">
        <Field label={t('calendar.block.type')}>
          <Segmented
            value={block}
            label={t('calendar.block.type')}
            options={[
              { value: 'event', label: t('calendar.block.event') },
              { value: 'focus', label: t('calendar.block.focus') },
              { value: 'ooo', label: t('calendar.block.ooo') },
            ]}
            onChange={(next) => {
              setBlock(next)
              const presetTitle = next === 'focus' ? t('calendar.block.focus') : next === 'ooo' ? t('calendar.block.ooo') : ''
              setTitle(current => current === '' || current === t('calendar.block.focus') || current === t('calendar.block.ooo') ? presetTitle : current)
              setColor(next === 'focus' ? '#8b5cf6' : next === 'ooo' ? '#f59e0b' : null)
            }}
          />
        </Field>
        <Field label={t('calendar.event.title_field')} required>
          <Input
            data-autofocus
            value={title}
            maxLength={MAX_EVENT_TITLE}
            placeholder={t('calendar.event.title_placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Checkbox checked={allDay} onChange={setAllDay} label={t('calendar.event.all_day')} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('calendar.event.start')}>
            <DatePicker label={t('calendar.event.start')} value={date} onChange={setDate} />
          </Field>
          {!allDay && (
            <Field label={t('calendar.event.start_time')}>
              <Input placeholder={t('calendar.event.time_placeholder')} value={startTime} onChange={(event) => setStartTime(event.target.value)} />
            </Field>
          )}
          <Field label={t('calendar.event.end')}>
            <DatePicker label={t('calendar.event.end')} value={endDate} onChange={setEndDate} />
          </Field>
          {!allDay && (
            <Field label={t('calendar.event.end_time')}>
              <Input placeholder={t('calendar.event.time_placeholder')} value={endTime} onChange={(event) => setEndTime(event.target.value)} />
            </Field>
          )}
        </div>
        <Field label={t('calendar.event.calendar')}>
          <Select value={calendarId} onChange={(event) => { setCalendarId(event.target.value); setResourceId('') }} disabled={writable.length === 0}>
            {writable.map(calendar => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </Select>
        </Field>
        {writable.length === 0 && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {t('calendar.event.no_writable_calendar')}
          </p>
        )}
        {resources.length > 0 && (
          <Field label={t('calendar.resources.book')}>
            <Select
              value={resourceId}
              onChange={(event) => {
                const next = event.target.value
                setResourceId(next)
                const resource = resources.find(item => item.id === next)
                if (resource) setCalendarId(resource.calendarId)
              }}
            >
              <option value="">{t('calendar.resources.none')}</option>
              {resources.map(resource => (
                <option key={resource.id} value={resource.id}>{resource.name}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('calendar.event.location')}>
          <Input
            value={location}
            maxLength={200}
            placeholder={t('calendar.event.location_placeholder')}
            onChange={(event) => setLocation(event.target.value)}
          />
        </Field>
        <Field label={t('calendar.event.description')}>
          <Textarea
            rows={3}
            maxLength={MAX_EVENT_DESCRIPTION}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('calendar.event.description_placeholder')}
          />
        </Field>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
