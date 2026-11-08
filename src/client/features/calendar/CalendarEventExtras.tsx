/**
 * The sidebar section for the event the reader just clicked.
 *
 * DayFlow's own editor owns the fields it renders, and it has no extension point that would let this
 * app add a row to it. Reminders are per event now, so they live here: the section reads the server's
 * row, writes back with its revision, and hands the new revision to the surface so the write queue
 * does not send a stale PATCH afterwards.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { LIMITS } from '@shared/constants'
import { formatBytes } from '@shared/byte-format'
import { CALENDAR_REMINDER_MINUTES, MAX_ATTACHMENTS_PER_EVENT, MAX_REMINDER_MINUTES, MAX_REMINDERS_PER_EVENT, temporalValueToEpochMs } from '@shared/calendar/model'
import type {
  CalendarAttachmentDto,
  CalendarAttendeeDto,
  CalendarAttendeeStatus,
  CalendarDto,
  CalendarEventDto,
} from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select, commitOnEnter } from '../../components/form'
import { X, Trash2, Copy, CopyPlus, FolderInput, BookmarkPlus, Video, Download } from 'lucide-react'
import * as api from './api'
import { CALENDAR_COLOR_PRESETS } from './model'
import { downloadCalendarText } from './calendar-download'
import { CalendarFilePicker } from './CalendarFilePicker'
import { CalendarEventTransferDialog } from './CalendarEventTransferDialog'
import { CalendarTemplatesDialog } from './CalendarTemplatesDialog'
import { CalendarTimeZoneField } from './CalendarTimeZoneField'
import { addAttendee, normalizeAttendeeEmail, withAttendeeStatus, withoutAttendee } from './attendees'
import { eventTimeZone, reanchorValue, shiftTemporalValue } from './timezone'

interface CalendarEventExtrasProps {
  eventId: string
  /** The zone the calendar itself is read in; an event without a zone of its own uses it. */
  accountTimeZone: string
  locale: string
  calendars: readonly CalendarDto[]
  /** True when any member calendar is read-only; the server would refuse every write anyway. */
  readOnly?: boolean
  onClose: () => void
  onRevision: (eventId: string, rev: number) => void
  /** The row moved in time: the surface has to re-read the range so the grid shows the new instant. */
  onChanged: (eventId: string) => void
}

function leadLabel(minutes: number): string {
  if (minutes === 0) return t('calendar.event.reminder_at_start')
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440)
    return days === 1 ? t('calendar.settings.reminder_day') : t('calendar.extras.reminder_days', { days })
  }
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
  calendars,
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
  const sharedEvent = eventId.startsWith('shared:')
  const [savingReminders, setSavingReminders] = useState(false)
  const [savingAttendees, setSavingAttendees] = useState(false)
  const [savingColor, setSavingColor] = useState(false)
  const [savingConference, setSavingConference] = useState(false)
  const [savingSnooze, setSavingSnooze] = useState(false)
  const [savingDuplicate, setSavingDuplicate] = useState(false)
  const [customReminder, setCustomReminder] = useState('')
  const [contacts, setContacts] = useState<Array<{ name: string; email: string }>>([])
  const contactListId = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<'copy' | 'move' | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const revisionRef = useRef(onRevision)
  revisionRef.current = onRevision

  useEffect(() => {
    let cancelled = false
    void api.getContacts().then((rows) => {
      if (!cancelled) setContacts(rows.map(row => ({ name: row.name, email: row.email })))
    }).catch(() => { /* The address book is a suggestion, not a requirement. */ })
    setEvent(null)
    setMinutes([])
    setAttendees([])
    setFiles([])
    setUploading(false)
    setSavingReminders(false)
    setSavingAttendees(false)
    setSavingColor(false)
    setSavingConference(false)
    setSavingSnooze(false)
    setSavingDuplicate(false)
    setCustomReminder('')
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

  const saveMinutes = (next: number[]): void => {
    if (rev === null || readOnly || savingReminders) return
    const previous = minutes
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

  const toggle = (lead: number): void => {
    saveMinutes(minutes.includes(lead)
      ? minutes.filter((value) => value !== lead)
      : [...minutes, lead].sort((left, right) => left - right))
  }

  const addCustomReminder = (): void => {
    const value = Number(customReminder.trim())
    if (!Number.isInteger(value) || value < 0 || value > MAX_REMINDER_MINUTES) {
      setError(t('calendar.extras.reminder_invalid', { limit: MAX_REMINDER_MINUTES / 1440 }))
      return
    }
    if (minutes.length >= MAX_REMINDERS_PER_EVENT && !minutes.includes(value)) {
      setError(t('calendar.extras.reminder_limit', { limit: MAX_REMINDERS_PER_EVENT }))
      return
    }
    setCustomReminder('')
    if (minutes.includes(value)) {
      setError(null)
      return
    }
    saveMinutes([...minutes, value].sort((left, right) => left - right))
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

  const changeColor = (color: string | null): void => {
    if (rev === null || readOnly || savingColor || event?.color === color) return
    setSavingColor(true)
    void (async () => {
      try {
        const saved = await api.updateEventPatch(eventId, { color }, rev)
        setEvent(saved)
        onRevision(eventId, saved.rev)
        onChanged(eventId)
        setError(null)
      } catch (saveError) {
        setError(saveError instanceof Error && saveError.message
          ? saveError.message
          : t('calendar.error.save_failed'))
      } finally {
        setSavingColor(false)
      }
    })()
  }

  const snooze = (minutes: number): void => {
    if (rev === null || readOnly) return
    setSavingSnooze(true)
    void api.snoozeEvent(eventId, minutes).then(
      (answer) => {
        useUi.getState().toast({
          title: t('calendar.extras.snoozed', { time: clockText(answer.notifyAt, accountTimeZone, locale) }),
          tone: 'success',
        })
        setError(null)
      },
      (saveError: unknown) => {
        setError(saveError instanceof Error && saveError.message ? saveError.message : t('calendar.error.save_failed'))
      },
    ).finally(() => setSavingSnooze(false))
  }

  const changeConference = (add: boolean): void => {
    if (!event || rev === null || readOnly) return
    setSavingConference(true)
    void (async () => {
      try {
        const meetingId = `inkstone-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
        const saved = await api.updateEventPatch(eventId, {
          conference: add
            ? { provider: 'jitsi', joinUrl: `https://meet.jit.si/${meetingId}`, meetingId }
            : null,
        }, rev)
        setEvent(saved)
        onRevision(eventId, saved.rev)
        setError(null)
      } catch (saveError) {
        setError(saveError instanceof Error && saveError.message
          ? saveError.message
          : t('calendar.error.save_failed'))
      } finally {
        setSavingConference(false)
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

  /**
   * A copy is created a day later than the row it came from: duplicating onto the same slot would
   * only stack two identical blocks and hide the one the reader just made.
   */
  const duplicate = (): void => {
    if (!event || readOnly || savingDuplicate) return
    setSavingDuplicate(true)
    setError(null)
    const input = {
      id: crypto.randomUUID(),
      title: event.title,
      description: event.description,
      kind: event.kind,
      conference: event.conference,
      start: shiftTemporalValue(event.start, 1),
      end: shiftTemporalValue(event.end, 1),
      allDay: event.allDay,
      calendarId: event.calendarId,
      calendarIds: event.calendarIds,
      meta: event.meta,
      icon: event.icon,
      color: event.color,
      recurrenceRule: null,
    }
    void api.createEvent(input)
      .then((saved) => {
        useUi.getState().toast({ title: t('calendar.event.copied'), tone: 'success' })
        onRevision(saved.id, saved.rev)
        onChanged(saved.id)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message ? cause.message : t('calendar.event.duplicate_failed'))
      })
      .finally(() => setSavingDuplicate(false))
  }

  const exportEvent = (): void => {
    if (!event || !event.calendarId || sharedEvent) return
    void api.exportIcs(event.calendarId, event.id)
      .then((content) => {
        downloadCalendarText(event.title || t('calendar.event.untitled'), content, 'ics')
        useUi.getState().toast({ title: t('calendar.event.exported'), tone: 'success' })
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message ? cause.message : t('calendar.event.export_failed'))
      })
  }

  const zone = event ? eventTimeZone(event.start, accountTimeZone) : null
  const startMillis = event ? Number(temporalValueToEpochMs(event.start, accountTimeZone)) : 0

  return (
    <section className="max-h-[45vh] shrink-0 overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
          {event?.title || t('calendar.event.untitled')}
        </h3>
        <IconButton label={t('calendar.event.copy_to')} size="sm" disabled={!event} onClick={() => setTransfer('copy')}>
          <Copy size={13} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('calendar.event.duplicate')}
          size="sm"
          disabled={!event || readOnly || savingDuplicate}
          onClick={duplicate}
        >
          <CopyPlus size={13} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('calendar.event.export_ics')}
          size="sm"
          disabled={!event || sharedEvent}
          onClick={exportEvent}
        >
          <Download size={13} aria-hidden="true" />
        </IconButton>
        <IconButton label={t('calendar.event.move_to')} size="sm" disabled={readOnly || sharedEvent || !event} onClick={() => setTransfer('move')}>
          <FolderInput size={13} aria-hidden="true" />
        </IconButton>
        <IconButton label={t('calendar.templates.save_current')} size="sm" disabled={!event} onClick={() => setTemplatesOpen(true)}>
          <BookmarkPlus size={13} aria-hidden="true" />
        </IconButton>
        <IconButton label={t('common.close')} size="sm" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {readOnly && (
        <p role="status" className="mt-1.5 rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)]">
          {t('calendar.extras.read_only')}
        </p>
      )}

      <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('calendar.calendar.color')}</p>
      <div role="group" aria-label={t('calendar.calendar.color')} className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={event?.color ? 'secondary' : 'primary'}
          aria-pressed={!event?.color}
          disabled={rev === null || readOnly || savingColor}
          onClick={() => changeColor(null)}
        >
          {t('calendar.event.no_color')}
        </Button>
        {CALENDAR_COLOR_PRESETS.map(color => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={event?.color?.toLowerCase() === color}
            disabled={rev === null || readOnly || savingColor}
            onClick={() => changeColor(color)}
            className="size-6 rounded-full border border-[var(--border-subtle)] transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-45"
            style={{ backgroundColor: color }}
          />
        ))}
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
            disabled={rev === null || readOnly || savingReminders}
            onClick={() => { toggle(lead) }}
          >
            {leadLabel(lead)}
          </Button>
        ))}
        {minutes
          .filter(lead => !(CALENDAR_REMINDER_MINUTES as readonly number[]).includes(lead))
          .map(lead => (
            <Button
              key={`custom-${lead}`}
              size="sm"
              variant="primary"
              aria-pressed
              disabled={rev === null || readOnly || savingReminders}
              onClick={() => { toggle(lead) }}
            >
              {leadLabel(lead)}
            </Button>
          ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_REMINDER_MINUTES}
          step={1}
          value={customReminder}
          aria-label={t('calendar.extras.custom_reminder')}
          placeholder={t('calendar.extras.custom_reminder_hint', { days: MAX_REMINDER_MINUTES / 1440 })}
          disabled={rev === null || readOnly || savingReminders}
          className="h-8 min-w-0 flex-1 text-[length:var(--text-12)]"
          onChange={event => setCustomReminder(event.target.value)}
          onKeyDown={(event) => { commitOnEnter(event, addCustomReminder) }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!customReminder.trim() || rev === null || readOnly || savingReminders}
          onClick={addCustomReminder}
        >
          {t('calendar.extras.add_reminder')}
        </Button>
      </div>
      {rev !== null && minutes.length === 0 && (
        <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('calendar.extras.follow_default')}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('calendar.extras.snooze')}>
        <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('calendar.extras.snooze')}</span>
        {[5, 10, 30].map(snoozeMinutes => (
          <Button
            key={snoozeMinutes}
            size="sm"
            variant="ghost"
            disabled={rev === null || readOnly || sharedEvent || savingSnooze}
            onClick={() => snooze(snoozeMinutes)}
          >
            {t('calendar.extras.snooze_minutes', { minutes: snoozeMinutes })}
          </Button>
        ))}
      </div>

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
        {t('calendar.extras.conference')}
      </p>
      {event?.conference
        ? (
            <div className="mt-1 flex items-center gap-1.5">
              <Video size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
              <a
                href={event.conference.joinUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {event.conference.meetingId || event.conference.joinUrl}
              </a>
              <IconButton
                size="xs"
                label={t('common.copy')}
                onClick={() => {
                  void navigator.clipboard.writeText(event.conference?.joinUrl ?? '').then(
                    () => useUi.getState().toast({ title: t('common.copied'), tone: 'success' }),
                    () => useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' }),
                  )
                }}
              >
                <Copy size={11} />
              </IconButton>
              <IconButton
                size="xs"
                label={t('calendar.extras.remove_conference')}
                disabled={rev === null || readOnly || savingConference}
                onClick={() => changeConference(false)}
              >
                <Trash2 size={11} />
              </IconButton>
            </div>
          )
        : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Video size={12} />}
              className="mt-1.5"
              disabled={rev === null || readOnly || savingConference}
              loading={savingConference}
              onClick={() => changeConference(true)}
            >
              {t('calendar.extras.add_conference')}
            </Button>
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
          list={contactListId}
          value={draft}
          placeholder={t('calendar.extras.attendee_email')}
          aria-label={t('calendar.extras.attendee_email')}
          disabled={rev === null || readOnly}
          onChange={(change) => { setDraft(change.target.value) }}
        />
        <Button size="sm" variant="secondary" type="submit" disabled={rev === null || readOnly || savingAttendees || draft.trim().length === 0}>
          {t('calendar.extras.add_attendee')}
        </Button>
        <datalist id={contactListId}>
          {contacts.map(contact => (
            <option key={contact.email} value={contact.email}>{contact.name}</option>
          ))}
        </datalist>
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
              disabled={readOnly || sharedEvent}
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
          disabled={rev === null || readOnly || uploading || sharedEvent}
          onPick={upload}
        />
      </div>
      {sharedEvent && (
        <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {t('calendar.extras.attachments_shared')}
        </p>
      )}
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

      {templatesOpen && event && (
        <CalendarTemplatesDialog
          open
          event={event}
          onClose={() => setTemplatesOpen(false)}
        />
      )}

      {transfer && event && (
        <CalendarEventTransferDialog
          open
          mode={transfer}
          event={event}
          calendars={calendars}
          reminders={minutes}
          attendees={attendees}
          onClose={() => setTransfer(null)}
          onDone={() => { setTransfer(null); onChanged(eventId) }}
        />
      )}
    </section>
  )
}
