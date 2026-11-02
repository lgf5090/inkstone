/**
 * Copy or move one event to another calendar.
 *
 * Copy creates a new row and carries the guest list and reminders; files stay with the original
 * because their bytes are account files, not event data. Move reuses the existing multi-calendar
 * membership write, so revisions and the server's write checks stay in one place.
 */
import { useEffect, useState } from 'react'
import type { CalendarAttendeeDto, CalendarDto, CalendarEventDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Field, Select } from '../../components/form'
import * as api from './api'

interface CalendarEventTransferDialogProps {
  open: boolean
  mode: 'copy' | 'move'
  event: CalendarEventDto
  calendars: readonly CalendarDto[]
  reminders: readonly number[]
  attendees: readonly CalendarAttendeeDto[]
  onClose: () => void
  onDone: () => void
}

export function CalendarEventTransferDialog({
  open,
  mode,
  event,
  calendars,
  reminders,
  attendees,
  onClose,
  onDone,
}: CalendarEventTransferDialogProps) {
  const current = new Set(event.calendarIds)
  const targets = calendars.filter(calendar => !calendar.readOnly && (mode === 'copy' || !current.has(calendar.id)))
  const [targetId, setTargetId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTargetId(targets[0]?.id ?? '')
    setSaving(false)
    setError(null)
  }, [open, mode, event.id, calendars])

  const submit = async (): Promise<void> => {
    if (!targetId) {
      setError(t('calendar.event.no_writable_calendar'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (mode === 'move') {
        const updated = await api.updateEventCalendars(event.id, [targetId], event.rev)
        void updated
        useUi.getState().toast({ title: t('calendar.event.moved'), tone: 'success' })
      } else {
        const created = await api.createEvent({
          ...event,
          id: crypto.randomUUID(),
          title: t('calendar.event.copy_of', { title: event.title }),
          calendarId: targetId,
          calendarIds: [targetId],
          rev: undefined,
          source: undefined,
          externalId: null,
        })
        let rev = created.rev
        if (reminders.length > 0) {
          rev = (await api.setEventReminders(created.id, [...reminders], rev)).event.rev
        }
        if (attendees.length > 0) {
          await api.setEventAttendees(created.id, [...attendees], rev)
        }
        useUi.getState().toast({ title: t('calendar.event.copied'), tone: 'success' })
      }
      onDone()
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message
        ? saveError.message
        : t('calendar.error.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'move' ? t('calendar.event.move_to') : t('calendar.event.copy_to')}
      width={420}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()} disabled={targets.length === 0}>
            {saving ? t('calendar.dialog.saving') : mode === 'move' ? t('calendar.event.move') : t('calendar.event.copy')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 pt-1">
        <Field label={t('calendar.event.calendar')}>
          <Select value={targetId} onChange={(event) => setTargetId(event.target.value)} disabled={targets.length === 0}>
            {targets.map(calendar => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </Select>
        </Field>
        {targets.length === 0 && (
          <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
            {t('calendar.event.no_writable_calendar')}
          </p>
        )}
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
      </div>
    </Modal>
  )
}
