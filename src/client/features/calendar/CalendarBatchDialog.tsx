import { useEffect, useState } from 'react'
import { Temporal } from 'temporal-polyfill'
import type { Event } from '@dayflow/react'
import { temporalToEpochMs } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal } from '../../components/overlay'
import { wallClockInZone } from './timezone'
import { CALENDAR_COLOR_LABEL_KEYS, CALENDAR_COLOR_PRESETS } from './model'

interface CalendarBatchDialogProps {
  open: boolean
  events: readonly Event[]
  timeZone: string
  onClose: () => void
  onMove: (date: string, time: string) => void
  onColor: (color: string) => void
}

export function CalendarBatchDialog({ open, events, timeZone, onClose, onMove, onColor }: CalendarBatchDialogProps) {
  const first = events[0]
  const [date, setDate] = useState('')
  const [time, setTime] = useState('09:00')
  const [color, setColor] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !first) return
    const allDay = first.allDay || first.start instanceof Temporal.PlainDate
    const wall = allDay
      ? { date: first.start.toString(), time: '09:00' }
      : wallClockInZone(new Date(temporalToEpochMs(first.start, timeZone)), timeZone)
    setDate(wall.date)
    setTime(wall.time)
    setColor('')
    setError(null)
  }, [open, first, timeZone])

  const move = (): void => {
    try {
      Temporal.PlainDate.from(date)
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('invalid_time')
      setError(null)
      onMove(date, time)
    } catch {
      setError(t('calendar.batch.invalid_move'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.batch.title', { count: events.length })}
      width={480}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="secondary" disabled={!color} onClick={() => { setError(null); onColor(color) }}>{t('calendar.batch.apply_color')}</Button>
          <Button variant="primary" onClick={move}>{t('calendar.batch.apply_move')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <Field label={t('calendar.batch.move_date')}>
          <Input value={date} onChange={event => setDate(event.target.value)} placeholder="YYYY-MM-DD" />
        </Field>
        <Field label={t('calendar.batch.move_time')}>
          <Input value={time} onChange={event => setTime(event.target.value)} placeholder={t('calendar.event.time_placeholder')} />
        </Field>
        <Field label={t('calendar.batch.color')}>
          <Select value={color} onChange={event => setColor(event.target.value)}>
            <option value="">{t('calendar.batch.color_none')}</option>
            {CALENDAR_COLOR_PRESETS.map((hex, index) => (
              <option key={hex} value={hex}>{t(CALENDAR_COLOR_LABEL_KEYS[index]!)}</option>
            ))}
          </Select>
        </Field>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
