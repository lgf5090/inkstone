/**
 * The sidebar section for the event the reader just clicked.
 *
 * DayFlow's own editor owns the fields it renders, and it has no extension point that would let this
 * app add a row to it. Reminders are per event now, so they live here: the section reads the server's
 * row, writes back with its revision, and hands the new revision to the surface so the write queue
 * does not send a stale PATCH afterwards.
 */
import { useEffect, useState } from 'react'
import { CALENDAR_REMINDER_MINUTES } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { X } from 'lucide-react'
import * as api from './api'

interface CalendarEventExtrasProps {
  eventId: string
  onClose: () => void
  onRevision: (eventId: string, rev: number) => void
}

function leadLabel(minutes: number): string {
  if (minutes === 0) return t('calendar.event.reminder_at_start')
  if (minutes >= 1440) return t('calendar.settings.reminder_day')
  return t('calendar.settings.reminder_minutes', { minutes })
}

export function CalendarEventExtras({ eventId, onClose, onRevision }: CalendarEventExtrasProps) {
  const [title, setTitle] = useState('')
  const [rev, setRev] = useState<number | null>(null)
  const [minutes, setMinutes] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRev(null)
    setMinutes([])
    setError(null)
    void (async () => {
      try {
        const event = await api.getEvent(eventId)
        if (cancelled) return
        if (!event) {
          setError(t('calendar.extras.gone'))
          return
        }
        const saved = await api.getEventReminders(event.id)
        if (cancelled) return
        setTitle(event.title)
        setRev(event.rev)
        setMinutes(saved)
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error && loadError.message
          ? loadError.message
          : t('calendar.extras.load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

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
        setRev(answer.event.rev)
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

  return (
    <section className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {title || t('calendar.event.untitled')}
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
      {error && (
        <p role="alert" className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  )
}
