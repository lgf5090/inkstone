/**
 * The sidebar section for the event the reader just clicked.
 *
 * DayFlow's own editor owns the fields it renders, and it has no extension point that would let this
 * app add a row to it. Reminders are per event now, so they live here: the section reads the server's
 * row, writes back with its revision, and hands the new revision to the surface so the write queue
 * does not send a stale PATCH afterwards.
 */
import { useEffect, useRef, useState } from 'react'
import { LIMITS } from '@shared/constants'
import { formatBytes } from '@shared/byte-format'
import { CALENDAR_REMINDER_MINUTES, MAX_ATTACHMENTS_PER_EVENT, temporalValueToEpochMs } from '@shared/calendar/model'
import type {
  CalendarAttachmentDto,
  CalendarAttendeeDto,
  CalendarAttendeeStatus,
  CalendarEventDto,
} from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { X, Trash2 } from 'lucide-react'
import * as api from './api'
import { CalendarFilePicker } from './CalendarFilePicker'
import { CalendarTimeZoneField } from './CalendarTimeZoneField'
import { addAttendee, normalizeAttendeeEmail, withAttendeeStatus, withoutAttendee } from './attendees'
import { eventTimeZone, reanchorValue } from './timezone'

interface CalendarEventExtrasProps {
  eventId: string
  /** The zone the calendar itself is read in; an event without a zone of its own uses it. */
  accountTimeZone: string
  locale: string
  /** True when any member calendar is read-only; the server would refuse every write anyway. */
  readOnly?: boolean
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

function statusLabels(): Record<CalendarAttendeeStatus, string> {
  return {
    'needs-action': t('calendar.attendee.needs_action'),
    accepted: t('calendar.attendee.accepted'),
    tentative: t('calendar.attendee.tentative'),
    declined: t('calendar.attendee.declined'),
  }
}

export function CalendarEventExtras({
  eventId,
  accountTimeZone,
  locale,
  readOnly = false,
  onClose,
  onRevision,
  onChanged,
}: CalendarEventExtrasProps) {
  const [event, setEvent] = useState<CalendarEventDto | null>(null)
  const [minutes, setMinutes] = useState<number[]>([])
  const [attendees, setAttendees] = useState<CalendarAttendeeDto[]>([])
  const [files, setFiles] = useState<CalendarAttachmentDto[]>([])
  const [uploading, setUploading] = useState(false)
  const [savingReminders, setSavingReminders] = useState(false)
  const [savingAttendees, setSavingAttendees] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const revisionRef = useRef(onRevision)
  revisionRef.current = onRevision

  useEffect(() => {
    let cancelled = false
    setEvent(null)
    setMinutes([])
    setAttendees([])
    setFiles([])
    setUploading(false)
    setSavingReminders(false)
    setSavingAttendees(false)
    setDraft('')
    setError(null)
    void (async () => {
      try {
        const found = await api.getEventExtras(eventId)
        if (cancelled) return
        if (!found) {
          setError(t('calendar.extras.gone'))
          return
        }
        setEvent(found.event)
        setMinutes(found.reminders)
        setAttendees(found.attendees)
        setFiles(found.attachments)
        revisionRef.current(found.event.id, found.event.rev)
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
    if (rev === null || readOnly || savingReminders) return
    const previous = minutes
    const next = previous.includes(lead)
      ? previous.filter((value) => value !== lead)
      : [...previous, lead].sort((left, right) => left - right)
    setMinutes(next)
    setSavingReminders(true)
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
      } finally {
        setSavingReminders(false)
      }
    })()
  }

  /** The whole list is replaced on every edit, so a failed write puts the previous one back. */
  const update = (next: CalendarAttendeeDto[]): void => {
    if (rev === null || readOnly || savingAttendees) return
    const previous = attendees
    setAttendees(next)
    setSavingAttendees(true)
    void (async () => {
      try {
        const answer = await api.setEventAttendees(eventId, next, rev)
        setEvent(answer.event)
        setAttendees(answer.attendees)
        onRevision(eventId, answer.event.rev)
        setError(null)
      } catch (saveError) {
        setAttendees(previous)
        setError(saveError instanceof Error && saveError.message
          ? saveError.message
          : t('calendar.error.save_failed'))
      } finally {
        setSavingAttendees(false)
      }
    })()
  }

  const invite = (): void => {
    const email = normalizeAttendeeEmail(draft)
    if (!email) {
      setError(t('calendar.extras.attendee_invalid'))
      return
    }
    const next = addAttendee(attendees, email)
    if (!next) {
      setDraft('')
      return
    }
    setDraft('')
    update(next)
  }

  /**
   * Files go up one at a time: a hand of them fired together would race the account's hourly budget
   * and report a failure count nobody could tie to a file. The size and the count are checked here only
   * as a courtesy — the route decides both for real.
   */
  const upload = (picked: FileList | null): void => {
    if (!picked?.length || rev === null || readOnly) return
    const chosen = Array.from(picked)
    void (async () => {
      setUploading(true)
      let room = MAX_ATTACHMENTS_PER_EVENT - files.length
      const problems: string[] = []
      try {
        for (const file of chosen) {
          if (file.size > LIMITS.attachmentMaxBytes) {
            problems.push(t('calendar.extras.attachment_too_large', { limit: formatBytes(LIMITS.attachmentMaxBytes) }))
            continue
          }
          if (room <= 0) {
            problems.push(t('calendar.extras.attachment_limit', { limit: MAX_ATTACHMENTS_PER_EVENT }))
            break
          }
          const saved = await api.uploadEventAttachment(eventId, file)
          room -= 1
          setFiles((current) => [...current, saved])
        }
        setError(problems[0] ?? null)
      } catch (uploadError) {
        setError(uploadError instanceof Error && uploadError.message
          ? uploadError.message
          : t('calendar.extras.attachment_failed'))
      } finally {
        setUploading(false)
      }
    })()
  }

  const removeFile = (file: CalendarAttachmentDto): void => {
    if (readOnly) return
    void (async () => {
      try {
        await api.removeEventAttachment(eventId, file.id)
        setFiles((current) => current.filter((entry) => entry.id !== file.id))
        setError(null)
      } catch (removeError) {
        setError(removeError instanceof Error && removeError.message
          ? removeError.message
          : t('calendar.extras.attachment_failed'))
      }
    })()
  }

  const changeZone = (zone: string): void => {
    if (!event || rev === null || event.allDay || readOnly) return
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
    <section className="max-h-[45vh] shrink-0 overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {event?.title || t('calendar.event.untitled')}
        </h3>
        <IconButton label={t('common.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {readOnly && (
        <p role="status" className="mt-1.5 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)]">
          {t('calendar.extras.read_only')}
        </p>
      )}

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
            disabled={rev === null || readOnly || savingReminders}
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
          <CalendarTimeZoneField
            className="mt-1.5 w-full"
            label={t('calendar.extras.timezone')}
            value={zone ?? accountTimeZone}
            disabled={rev === null || readOnly}
            onChange={changeZone}
          />
          <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('calendar.extras.timezone_shown', {
              local: clockText(startMillis, zone ?? accountTimeZone, locale),
              account: clockText(startMillis, accountTimeZone, locale),
            })}
          </p>
        </>
      )}

      <p className="mt-2.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('calendar.extras.attendees')}
      </p>
      {attendees.length === 0 && (
        <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('calendar.extras.no_attendees')}
        </p>
      )}
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {attendees.map((attendee) => (
          <li key={attendee.email} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]" title={attendee.email}>
              {attendee.name || attendee.email}
            </span>
            <Select
              className="w-auto min-w-24 text-[length:var(--text-11-5)]"
              aria-label={`${t('calendar.extras.attendee_status')}: ${attendee.email}`}
              value={attendee.status}
              disabled={rev === null || readOnly || savingAttendees}
              onChange={(change) => { update(withAttendeeStatus(attendees, attendee.email, change.target.value as CalendarAttendeeStatus)) }}
            >
              {Object.entries(statusLabels()).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
            <IconButton
              label={t('calendar.extras.remove_attendee', { email: attendee.email })}
              size="sm"
              disabled={readOnly || savingAttendees}
              onClick={() => { update(withoutAttendee(attendees, attendee.email)) }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        className="mt-1.5 flex items-center gap-1.5"
        noValidate
        onSubmit={(event) => { event.preventDefault(); invite() }}
      >
        <Input
          className="min-w-0 flex-1"
          type="email"
          value={draft}
          placeholder={t('calendar.extras.attendee_email')}
          aria-label={t('calendar.extras.attendee_email')}
          disabled={rev === null || readOnly}
          onChange={(change) => { setDraft(change.target.value) }}
        />
        <Button size="sm" variant="secondary" type="submit" disabled={rev === null || readOnly || savingAttendees || draft.trim().length === 0}>
          {t('calendar.extras.add_attendee')}
        </Button>
      </form>

      <p className="mt-2.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        {t('calendar.extras.attachments')}
      </p>
      {files.length === 0 && (
        <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('calendar.extras.no_attachments')}
        </p>
      )}
      <ul className="mt-1.5 flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.id} className="flex items-center gap-2">
            <a
              href={file.url}
              download={file.filename}
              title={file.filename}
              className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
            >
              {file.filename}
            </a>
            <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {formatBytes(file.size)}
            </span>
            <IconButton
              label={t('calendar.extras.remove_attachment', { name: file.filename })}
              size="sm"
              disabled={readOnly}
              onClick={() => { removeFile(file) }}
            >
              <Trash2 size={13} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="mt-1.5">
        <CalendarFilePicker
          label={t('calendar.extras.add_attachment')}
          multiple
          disabled={rev === null || readOnly || uploading}
          onPick={upload}
        />
      </div>
      {uploading && (
        <p role="status" className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('calendar.extras.uploading')}
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
