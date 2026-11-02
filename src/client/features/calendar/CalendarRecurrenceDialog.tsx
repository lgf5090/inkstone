/**
 * The scope question a recurring-event edit raises.
 *
 * The library asks one event to stand for a whole series, so an edit aimed at one occurrence is
 * turned into a server-side exception ("this"), a split ("following") or a master edit ("all").
 * Nothing is written until the reader answers; the optimistic change was already reverted.
 */
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { CalendarEventInput } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Segmented } from '../../components/form'
import type { RecurrenceOccurrenceRequest } from './persistence'
import { toEventInput } from './model'
import * as api from './api'

type Scope = 'this' | 'following' | 'all'

export function CalendarRecurrenceDialog({
  request,
  timeZone,
  onClose,
  onApplied,
}: {
  request: RecurrenceOccurrenceRequest
  timeZone: string
  onClose: () => void
  onApplied: () => void | Promise<void>
}) {
  const [scope, setScope] = useState<Scope>('this')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleting = request.intent === 'delete'

  const apply = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      let patch: Partial<CalendarEventInput> | undefined
      if (!deleting && request.after) {
        const after = toEventInput(request.after, { fallbackTitle: t('calendar.event.untitled'), timeZone })
        patch = {
          title: after.title,
          description: after.description,
          start: after.start,
          end: after.end,
          allDay: after.allDay,
          color: after.color,
        }
      }
      await api.applyRecurrenceChange(request.masterId, {
        occurrenceStart: toEventInput(request.before, { fallbackTitle: t('calendar.event.untitled'), timeZone }).start,
        occurrenceEnd: toEventInput(request.before, { fallbackTitle: t('calendar.event.untitled'), timeZone }).end,
        scope,
        action: deleting ? 'cancel' : 'update',
        ...(patch ? { patch } : {}),
      })
      await onApplied()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.recurrence.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={deleting ? t('calendar.recurrence.delete_title') : t('calendar.recurrence.edit_title')}
      description={t('calendar.recurrence.description')}
      width={440}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant={deleting ? 'danger' : 'primary'} loading={saving} onClick={() => void apply()}>
            {deleting ? t('calendar.recurrence.delete_confirm') : t('calendar.recurrence.apply')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 pt-1">
        <Segmented
          value={scope}
          onChange={setScope}
          disabled={saving}
          label={t('calendar.recurrence.scope')}
          options={[
            { value: 'this', label: deleting ? t('calendar.recurrence.only_this_delete') : t('calendar.recurrence.only_this') },
            { value: 'following', label: deleting ? t('calendar.recurrence.following_delete') : t('calendar.recurrence.following') },
            { value: 'all', label: deleting ? t('calendar.recurrence.all_delete') : t('calendar.recurrence.all') },
          ]}
        />
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Modal>
  )
}
