/** Meeting rooms and shared equipment: each resource owns a calendar its reservations live in. */
import { useEffect, useState } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import type { CalendarResourceDto } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { confirm, Modal } from '../../components/overlay'
import { Field, Input } from '../../components/form'
import * as api from './api'

export function CalendarResourcesDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [resources, setResources] = useState<CalendarResourceDto[]>([])
  const [name, setName] = useState('')
  const [capacityText, setCapacityText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSaving(false)
    setError(null)
    void api.getResources().then(
      (rows) => { if (!cancelled) setResources(rows) },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error && cause.message ? cause.message : t('calendar.resources.failed')) },
    )
    return () => { cancelled = true }
  }, [open])

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const capacity = capacityText.trim() ? Number(capacityText) : null
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 10_000)) {
      setError(t('calendar.resources.bad_capacity'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await api.createResource({ name: name.trim(), capacity })
      setResources(rows => [...rows, created].sort((left, right) => left.name.localeCompare(right.name)))
      setName('')
      setCapacityText('')
      useUi.getState().toast({ title: t('calendar.resources.created'), tone: 'success' })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.resources.failed'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (resource: CalendarResourceDto): Promise<void> => {
    const confirmed = await confirm({
      title: t('calendar.resources.delete_title'),
      description: t('calendar.resources.delete_body', { name: resource.name }),
      confirmLabel: t('calendar.resources.delete'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.deleteResource(resource.id)
      setResources(rows => rows.filter(row => row.id !== resource.id))
      useUi.getState().toast({ title: t('calendar.resources.deleted'), tone: 'success' })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('calendar.resources.failed'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.resources.title')}
      description={t('calendar.resources.description')}
      width={460}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3 pt-1">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Field label={t('calendar.resources.name')} className="min-w-0 flex-1">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('calendar.resources.name_placeholder')}
              aria-label={t('calendar.resources.name')}
              maxLength={100}
            />
          </Field>
          <Field label={t('calendar.resources.capacity')} className="w-24 shrink-0">
            <Input
              type="number"
              min={1}
              max={10000}
              value={capacityText}
              onChange={(event) => setCapacityText(event.target.value)}
              aria-label={t('calendar.resources.capacity')}
            />
          </Field>
          <Button type="submit" variant="primary" loading={saving} disabled={saving || !name.trim()}>
            {t('calendar.resources.add')}
          </Button>
        </form>
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {resources.length === 0
          ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('calendar.resources.empty')}</p>
          : (
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {resources.map(resource => (
                  <li
                    key={resource.id}
                    className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{resource.name}</span>
                      {resource.capacity !== null && (
                        <span className="block text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                          {t('calendar.resources.seats', { count: resource.capacity })}
                        </span>
                      )}
                    </span>
                    <IconButton size="xs" label={t('calendar.resources.delete')} onClick={() => void remove(resource)}>
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
