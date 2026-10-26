/**
 * The sidebar section for the event the reader just clicked.
 *
 * DayFlow's own editor owns the fields it renders, and it has no extension point that would let this
 * app add a row to it. Reminders are per event now, so they live here: the section reads the server's
 * row, writes back with its revision, and hands the new revision to the surface so the write queue
 * does not send a stale PATCH afterwards.
 */
import { useEffect, useState } from 'react'
import { CALENDAR_REMINDER_MINUTES, temporalValueToEpochMs } from '@shared/calendar/model'
import type { CalendarEventDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Select } from '../../components/form'
import { X } from 'lucide-react'
import * as api from './api'
import { eventTimeZone, reanchorValue, supportedTimeZones } from './timezone'

interface CalendarEventExtrasProps {
  eventId: string
  /** The zone the calendar itself is read in; an event without a zone of its own uses it. */
  accountTimeZone: string
  locale: string
  onClose: () => void
  onRevision: (eventId: string, rev: number) => void
  /** The row moved in time: the surface has to re-read the range so the grid shows the new instant. */
  onChanged: (eventId: string) => void
}

function leadLabel(minutes: number): string {
  if (minutes === 0) return t('calendar.event.reminder_at_start')
  if (minutes >= 1440) return t('calendar.settings.reminder_day')
  return t('calendar.settings.reminder_minutes', { minutes })
}

function clockText(millis: number, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone,
  }).format(new Date(millis))
}

export function CalendarEventExtras({
  eventId,
  accountTimeZone,
  locale,
  onClose,
  onRevision,
  onChanged,
}: CalendarEventExtrasProps) {
  const [event, setEvent] = useState<CalendarEventDto | null>(null)
  const [minutes, setMinutes] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const zones = supportedTimeZones()

  useEffect(() => {
    let cancelled = false
    setEvent(null)
    setMinutes([])
    setError(null)
    void (async () => {
      try {
        const found = await api.getEvent(eventId)
        if (cancelled) return
        if (!found) {
          setError(t('calendar.extras.gone'))
          return
        }
        const saved = await api.getEventReminders(found.id)
        if (cancelled) return
        setEvent(found)
        setMinutes(saved)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error && loadError.message
          ? loadError.message
          : t('calendar.extras.load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

  const rev = event?.rev ?? null

  const save = async (write: () => Promise<CalendarEventDto>): Promise<void> => {
    try {
      const saved = await write()
      setEvent(saved)
      onRevision(eventId, saved.rev)
      onChanged(eventId)
      setError(null)
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message
        ? saveError.message
        : t('calendar.error.save_failed'))
    }
  }

  const toggle = (lead: number): void => {
    if (rev === null) return
    const previous = minutes
    const next = previous.includes(lead)
      ? previous.filter((value) => value !== lead)
      : [...previous, lead].sort((left, right) => left - right)
    setMinutes(next)
    void (async () => {
      try {
        const answer = await api.setEventReminders(eventId, next, rev)
        setEvent(answer.event)
        onRevision(eventId, answer.event.rev)
        setError(null)
      } catch (saveError) {
        setMinutes(previous)
        setError(saveError instanceof Error && saveError.message
          ? saveError.message
          : t('calendar.error.save_failed'))
      }
    })()
  }

  const changeZone = (zone: string): void => {
    if (!event || rev === null || event.allDay) return
    const previous = event
    const moved = {
      ...event,
      start: reanchorValue(event.start, zone),
      end: reanchorValue(event.end, zone),
    }
    setEvent({ ...event, start: moved.start, end: moved.end })
    void save(() => api.updateEvent(eventId, moved, rev).catch((error: unknown) => {
      setEvent(previous)
      throw error
    }))
  }

  const zone = event ? eventTimeZone(event.start, accountTimeZone) : null
  const startMillis = event ? Number(temporalValueToEpochMs(event.start, accountTimeZone)) : 0

  return (
    <section className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {event?.title || t('calendar.event.untitled')}
        </h3>
        <IconButton label={t('common.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('calendar.settings.reminder')}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={t('calendar.settings.reminder')}>
        {CALENDAR_REMINDER_MINUTES.map((lead) => (
          <Button
            key={lead}
            size="sm"
            variant={minutes.includes(lead) ? 'primary' : 'secondary'}
            aria-pressed={minutes.includes(lead)}
            disabled={rev === null}
            onClick={() => { toggle(lead) }}
          >
            {leadLabel(lead)}
          </Button>
        ))}
      </div>
      {rev !== null && minutes.length === 0 && (
        <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('calendar.extras.follow_default')}
        </p>
      )}

      <p className="mt-2.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('calendar.extras.timezone')}
      </p>
      {event?.allDay ? (
        <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('calendar.extras.timezone_all_day')}
        </p>
      ) : (
        <>
          <Select
            className="mt-1.5 w-full"
            aria-label={t('calendar.extras.timezone')}
            value={zone ?? accountTimeZone}
            disabled={rev === null}
            onChange={(change) => { changeZone(change.target.value) }}
          >
            {!zones.includes(zone ?? '') && zone && <option value={zone}>{zone}</option>}
            {zones.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </Select>
          <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('calendar.extras.timezone_shown', {
              local: clockText(startMillis, zone ?? accountTimeZone, locale),
              account: clockText(startMillis, accountTimeZone, locale),
            })}
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  )
}
