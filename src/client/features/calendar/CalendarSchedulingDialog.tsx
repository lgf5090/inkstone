/** Owner side of booking links: the window, the target calendar, and the public address. */
import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, Link2, Trash2 } from 'lucide-react'
import type { CalendarDto, CalendarSchedulingLinkDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { copyText } from '../../lib/clipboard'
import { Button, IconButton } from '../../components/primitives'
import { confirm, Modal } from '../../components/overlay'
import { Checkbox, Field, Input, Select, Switch } from '../../components/form'
import * as api from './api'

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const
const DURATIONS = [15, 30, 45, 60, 90] as const
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

function weekdayLabel(day: number): string {
  switch (day) {
    case 0: return t('calendar.settings.weekday_0')
    case 1: return t('calendar.settings.weekday_1')
    case 2: return t('calendar.settings.weekday_2')
    case 3: return t('calendar.settings.weekday_3')
    case 4: return t('calendar.settings.weekday_4')
    case 5: return t('calendar.settings.weekday_5')
    default: return t('calendar.settings.weekday_6')
  }
}

export function CalendarSchedulingDialog({
  open,
  calendars,
  onClose,
}: {
  open: boolean
  calendars: readonly CalendarDto[]
  onClose: () => void
}) {
  const writable = calendars.filter(calendar => !calendar.readOnly)
  const [links, setLinks] = useState<CalendarSchedulingLinkDto[]>([])
  const [title, setTitle] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const [duration, setDuration] = useState(30)
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [startHour, setStartHour] = useState(9)
  const [endHour, setEndHour] = useState(17)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSaving(false)
    setError(null)
    setTitle('')
    setDuration(30)
    setDays([1, 2, 3, 4, 5])
    setStartHour(9)
    setEndHour(17)
    setCalendarId(writable[0]?.id ?? '')
    void api.getSchedulingLinks().then(
      (rows) => { if (!cancelled) setLinks(rows) },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error && cause.message ? cause.message : t('calendar.scheduling.failed')) },
    )
    return () => { cancelled = true }
  }, [open, calendars])

  const toggleDay = (day: number, checked: boolean): void => {
    setDays(current => checked ? [...new Set([...current, day])] : current.filter(value => value !== day))
  }

  const create = async (): Promise<void> => {
    if (!title.trim() || !calendarId || days.length === 0 || endHour <= startHour) {
      setError(t('calendar.scheduling.invalid'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const link = await api.createSchedulingLink({
        calendarId,
        title: title.trim(),
        durationMinutes: duration,
        days,
        startHour,
        endHour,
      })
      setLinks(rows => [...rows, link])
      setTitle('')
      useUi.getState().toast({ title: t('calendar.scheduling.created'), tone: 'success' })
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.scheduling.failed'))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (link: CalendarSchedulingLinkDto): Promise<void> => {
    try {
      const updated = await api.updateSchedulingLink(link.id, { enabled: !link.enabled })
      setLinks(rows => rows.map(row => row.id === updated.id ? updated : row))
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.scheduling.failed'))
    }
  }

  const remove = async (link: CalendarSchedulingLinkDto): Promise<void> => {
    const confirmed = await confirm({
      title: t('calendar.scheduling.delete_title'),
      description: t('calendar.scheduling.delete_body', { title: link.title }),
      confirmLabel: t('calendar.scheduling.delete'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.deleteSchedulingLink(link.id)
      setLinks(rows => rows.filter(row => row.id !== link.id))
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.scheduling.failed'))
    }
  }

  const copy = async (link: CalendarSchedulingLinkDto): Promise<void> => {
    const url = `${window.location.origin}/schedule/${link.slug}`
    if (await copyText(url)) useUi.getState().toast({ title: t('common.copied'), tone: 'success' })
    else useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.scheduling.title')}
      description={t('calendar.scheduling.description')}
      width={560}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3 pt-1">
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <form
          className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5"
          onSubmit={(event) => { event.preventDefault(); void create() }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('calendar.scheduling.link_title')} className="col-span-2">
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('calendar.scheduling.link_title_placeholder')}
                maxLength={160}
              />
            </Field>
            <Field label={t('calendar.scheduling.calendar')}>
              <Select value={calendarId} onChange={(event) => setCalendarId(event.target.value)}>
                {writable.map(calendar => (
                  <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('calendar.scheduling.duration')}>
              <Select value={String(duration)} onChange={(event) => setDuration(Number(event.target.value))}>
                {DURATIONS.map(minutes => (
                  <option key={minutes} value={minutes}>{t('calendar.settings.reminder_minutes', { minutes })}</option>
                ))}
              </Select>
            </Field>
          </div>
          <fieldset>
            <legend className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('calendar.scheduling.days')}</legend>
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
              {WEEKDAYS.map(day => (
                <Checkbox
                  key={day}
                  checked={days.includes(day)}
                  onChange={(checked) => toggleDay(day, checked)}
                  label={weekdayLabel(day)}
                />
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('calendar.scheduling.from_hour')}>
              <Select value={String(startHour)} onChange={(event) => setStartHour(Number(event.target.value))}>
                {HOURS.map(hour => <option key={hour} value={hour}>{`${String(hour).padStart(2, '0')}:00`}</option>)}
              </Select>
            </Field>
            <Field label={t('calendar.scheduling.to_hour')}>
              <Select value={String(endHour)} onChange={(event) => setEndHour(Number(event.target.value))}>
                {HOURS.map(hour => <option key={hour} value={hour}>{`${String(hour).padStart(2, '0')}:00`}</option>)}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={saving} disabled={saving || writable.length === 0}>
            {t('calendar.scheduling.create')}
          </Button>
        </form>

        {links.length === 0
          ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.scheduling.empty')}</p>
          : (
              <ul className="space-y-1">
                {links.map(link => (
                  <li
                    key={link.id}
                    className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5"
                  >
                    <Link2 size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{link.title}</span>
                      <span className="block truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                        {`/schedule/${link.slug}`}
                      </span>
                    </span>
                    <Switch label={link.title} checked={link.enabled} onChange={() => void toggle(link)} />
                    <IconButton size="xs" label={t('calendar.scheduling.copy')} onClick={() => void copy(link)}>
                      <Copy size={12} />
                    </IconButton>
                    <IconButton size="xs" label={t('calendar.scheduling.delete')} onClick={() => void remove(link)}>
                      <Trash2 size={12} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </Modal>
  )
}
