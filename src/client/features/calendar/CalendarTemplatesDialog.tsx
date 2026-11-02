/**
 * Reusable event drafts, and the one place a current event becomes a template.
 *
 * A template stores only the fields an event starts with; dates are chosen again at use time. The
 * dialog is opened from the sidebar (list/use) and from the event card (save the current event).
 */
import { useEffect, useState } from 'react'
import { Trash2, Wand2 } from 'lucide-react'
import type { CalendarEventDto, CalendarTemplateDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Field, Input } from '../../components/form'
import { useUi } from '../../store/ui'
import * as api from './api'

interface CalendarTemplatesDialogProps {
  open: boolean
  /** When present, the dialog can save this event as a template. */
  event?: CalendarEventDto | null
  onUse?: (template: CalendarTemplateDto) => void
  onClose: () => void
}

export function CalendarTemplatesDialog({ open, event, onUse, onClose }: CalendarTemplatesDialogProps) {
  const [templates, setTemplates] = useState<CalendarTemplateDto[]>([])
  const [name, setName] = useState('')
  const [blankDuration, setBlankDuration] = useState('60')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(event?.title ?? '')
    setSaving(false)
    setError(null)
    void api.getTemplates().then(setTemplates).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : t('calendar.templates.load_failed'))
    })
  }, [open, event?.id, event?.title])

  const save = async (): Promise<void> => {
    const templateName = name.trim() || event?.title.trim() || ''
    if (!templateName) {
      setError(t('calendar.templates.name'))
      return
    }
    const minutes = Number(blankDuration)
    if (!event && (!Number.isInteger(minutes) || minutes < 5 || minutes > 480)) {
      setError(t('calendar.templates.duration_invalid'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const duration = event
        ? event.allDay
          ? 0
          : Math.max(5, Math.round((startOf(event.end) - startOf(event.start)) / 60_000))
        : minutes
      const created = await api.createTemplate({
        name: templateName,
        title: event?.title ?? templateName,
        description: event?.description ?? '',
        kind: event?.kind ?? 'event',
        allDay: event?.allDay ?? false,
        durationMinutes: duration,
        color: event?.color ?? null,
      })
      setTemplates(current => [...current, created].sort((left, right) => left.name.localeCompare(right.name)))
      useUi.getState().toast({ title: t('calendar.templates.saved'), tone: 'success' })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('calendar.templates.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (template: CalendarTemplateDto): Promise<void> => {
    try {
      await api.deleteTemplate(template.id)
      setTemplates(current => current.filter(item => item.id !== template.id))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('calendar.templates.delete_failed'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.templates.title')}
      description={t('calendar.templates.description')}
      width={500}
      footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Field label={t('calendar.templates.name')}>
            <Input value={name} maxLength={80} onChange={(change) => setName(change.target.value)} />
          </Field>
          {!event && (
            <Field label={t('calendar.templates.duration')}>
              <Input
                type="number"
                min={5}
                max={480}
                value={blankDuration}
                onChange={(change) => setBlankDuration(change.target.value)}
              />
            </Field>
          )}
          <div className="flex items-end">
            <Button variant="secondary" loading={saving} onClick={() => void save()}>
              {event ? t('calendar.templates.save_current') : t('calendar.templates.create')}
            </Button>
          </div>
        </div>
        {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {templates.length === 0 && <p className="py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.templates.empty')}</p>}
        <ul className="divide-y divide-[var(--border-subtle)]">
          {templates.map(template => (
            <li key={template.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{template.name}</span>
                <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {template.title}{template.allDay ? ` · ${t('calendar.event.all_day')}` : ` · ${template.durationMinutes} min`}
                </span>
              </span>
              {onUse && (
                <IconButton size="sm" label={t('calendar.templates.use')} onClick={() => onUse(template)}>
                  <Wand2 size={13} aria-hidden="true" />
                </IconButton>
              )}
              <IconButton size="sm" label={t('calendar.templates.delete')} onClick={() => void remove(template)}>
                <Trash2 size={13} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

function startOf(value: CalendarEventDto['start']): number {
  if (value.type === 'date') {
    const [year, month, day] = value.value.split('-').map(Number)
    return new Date(year!, month! - 1, day!).getTime()
  }
  return new Date(value.value).getTime()
}
