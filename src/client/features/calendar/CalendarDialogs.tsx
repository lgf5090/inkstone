/**
 * Calendar administration dialogs.
 *
 * Each dialog owns the request it makes, keeps its refusals inside the panel instead of closing it,
 * and calls `onSaved` so the container can refresh metadata and the DayFlow registry. The shell's
 * `Modal` supplies focus trapping, Escape and focus return; these never use native prompts.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { CalendarDto, CalendarGroupDto } from '@shared/calendar/model'
import { MAX_ICS_BYTES } from '@shared/calendar/model'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { Checkbox, Field, Input, Segmented, Select } from '../../components/form'
import { ColorWellField } from '../../components/color-field'
import { CALENDAR_COLOR_PRESETS, deriveDarkColor } from './model'
import * as api from './api'

interface DialogBaseProps {
  open: boolean
  onClose: () => void
  onSaved: () => void | Promise<void>
}

function errorMessage(error: unknown, fallbackKey: 'calendar.calendar.action_failed' | 'calendar.import.failed' | 'calendar.subscription.failed' | 'calendar.group.failed'): string {
  if (error instanceof Error && error.message) return error.message
  return t(fallbackKey)
}

function DialogError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
      <AlertTriangle size={13} className="mt-[2px] shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function ColorPresets({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div role="group" aria-label={t('calendar.calendar.color')} className="flex flex-wrap items-center gap-1.5">
      {CALENDAR_COLOR_PRESETS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={value.toLowerCase() === color}
          onClick={() => onChange(color)}
          className="relative size-6 rounded-full border border-[var(--border-subtle)] transition-transform hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          style={{ backgroundColor: color }}
        >
          {value.toLowerCase() === color && <span className="absolute inset-1 rounded-full ring-2 ring-[var(--bg-base)]" aria-hidden="true" />}
        </button>
      ))}
      <ColorWellField value={value} label={t('calendar.calendar.custom_color')} onChange={onChange} />
    </div>
  )
}

interface CalendarFormDialogProps extends DialogBaseProps {
  mode: 'create' | 'edit'
  calendar?: CalendarDto | null
  groups: CalendarGroupDto[]
  defaultGroupId?: string | null
}

export function CalendarFormDialog({ open, mode, calendar, groups, defaultGroupId, onClose, onSaved }: CalendarFormDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(CALENDAR_COLOR_PRESETS[5])
  const [groupId, setGroupId] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(mode === 'edit' ? calendar?.name ?? '' : '')
    setColor(mode === 'edit' ? calendar?.color ?? CALENDAR_COLOR_PRESETS[5] : CALENDAR_COLOR_PRESETS[5])
    setGroupId(mode === 'edit' ? calendar?.groupId ?? '' : defaultGroupId ?? '')
    setIsDefault(false)
    setError(null)
    setSaving(false)
  }, [open, mode, calendar, defaultGroupId])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('calendar.calendar.name_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (mode === 'edit' && calendar) {
        await api.updateCalendar(calendar.id, {
          name: trimmed,
          color,
          darkColor: deriveDarkColor(color),
          groupId: groupId || null,
        }, calendar.rev)
        useUi.getState().toast({ title: t('calendar.calendar.updated'), tone: 'success' })
      } else {
        await api.createCalendar({
          name: trimmed,
          color,
          darkColor: deriveDarkColor(color),
          groupId: groupId || null,
          isDefault,
        })
        useUi.getState().toast({ title: t('calendar.calendar.created'), tone: 'success' })
      }
      await onSaved()
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, 'calendar.calendar.action_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'edit' ? t('calendar.calendar.edit') : t('calendar.calendar.new')}
      width={440}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {saving ? t('calendar.dialog.saving') : t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4 pt-1">
        <Field label={t('calendar.calendar.name')} required>
          <Input
            data-autofocus
            value={name}
            maxLength={80}
            placeholder={t('calendar.calendar.name_placeholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </Field>
        <Field label={t('calendar.calendar.color')}>
          <div><ColorPresets value={color} onChange={setColor} /></div>
        </Field>
        <Field label={t('calendar.calendar.group')}>
          <Select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">{t('calendar.calendar.no_group')}</option>
            {groups.map(group => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </Select>
        </Field>
        {mode === 'create' && (
          <Checkbox
            checked={isDefault}
            onChange={setIsDefault}
            label={t('calendar.calendar.default')}
          />
        )}
        {error && <DialogError>{error}</DialogError>}
      </div>
    </Modal>
  )
}

interface GroupDialogProps extends DialogBaseProps {
  mode: 'create' | 'rename'
  group?: CalendarGroupDto | null
}

export function GroupDialog({ open, mode, group, onClose, onSaved }: GroupDialogProps) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(mode === 'rename' ? group?.name ?? '' : '')
    setError(null)
    setSaving(false)
  }, [open, mode, group])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('calendar.calendar.name_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (mode === 'rename' && group) await api.renameGroup(group.id, trimmed)
      else await api.createGroup(trimmed)
      useUi.getState().toast({ title: t('calendar.group.saved'), tone: 'success' })
      await onSaved()
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, 'calendar.group.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'rename' ? t('calendar.group.rename') : t('calendar.group.new')}
      width={400}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {saving ? t('calendar.dialog.saving') : t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 pt-1">
        <Field label={t('calendar.group.name')} required>
          <Input
            data-autofocus
            value={name}
            maxLength={50}
            placeholder={t('calendar.group.name_placeholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </Field>
        {error && <DialogError>{error}</DialogError>}
      </div>
    </Modal>
  )
}

interface DeleteCalendarDialogProps extends DialogBaseProps {
  calendar: CalendarDto
  calendars: CalendarDto[]
}

export function DeleteCalendarDialog({ open, calendar, calendars, onClose, onSaved }: DeleteCalendarDialogProps) {
  const targets = calendars.filter(item => item.id !== calendar.id)
  const [mode, setMode] = useState<'delete' | 'merge'>('delete')
  const [targetId, setTargetId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode(targets.length > 0 ? 'merge' : 'delete')
    setTargetId(targets[0]?.id ?? '')
    setError(null)
    setSaving(false)
  }, [open, calendar.id, calendars])

  const submit = async (): Promise<void> => {
    if (mode === 'merge' && !targetId) {
      setError(t('calendar.calendar.target_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (mode === 'merge') await api.deleteCalendar(calendar.id, { kind: 'merge', targetId })
      else await api.deleteCalendar(calendar.id, { kind: 'delete', rev: calendar.rev })
      useUi.getState().toast({
        title: mode === 'merge' ? t('calendar.calendar.merged') : t('calendar.calendar.deleted'),
        tone: 'success',
      })
      await onSaved()
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, 'calendar.calendar.action_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.calendar.delete_title', { name: calendar.name })}
      description={t('calendar.calendar.delete_description')}
      width={440}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={saving} onClick={() => void submit()}>
            {saving
              ? t('calendar.dialog.deleting')
              : mode === 'merge'
                ? t('calendar.calendar.merge_into')
                : t('calendar.calendar.delete_confirm')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3 pt-1">
        {targets.length > 0 && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'merge', label: t('calendar.calendar.merge_into') },
              { value: 'delete', label: t('calendar.calendar.delete_events') },
            ]}
          />
        )}
        {mode === 'merge' && targets.length > 0 && (
          <Field label={t('calendar.calendar.merge_into')} required>
            <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targets.map(target => (
                <option key={target.id} value={target.id}>{target.name}</option>
              ))}
            </Select>
          </Field>
        )}
        {error && <DialogError>{error}</DialogError>}
      </div>
    </Modal>
  )
}

interface ImportIcsDialogProps extends DialogBaseProps {
  calendars: CalendarDto[]
  defaultTimeZone: string
}

function isIcsFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.ics') || file.type === 'text/calendar'
}

export function ImportIcsDialog({ open, calendars, defaultTimeZone, onClose, onSaved }: ImportIcsDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [targetId, setTargetId] = useState('')
  const [newName, setNewName] = useState('')
  const [color, setColor] = useState<string>(CALENDAR_COLOR_PRESETS[5])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setFile(null)
    setMode(calendars.length > 0 ? 'existing' : 'new')
    setTargetId(calendars[0]?.id ?? '')
    setNewName('')
    setColor(CALENDAR_COLOR_PRESETS[5])
    setError(null)
    setSaving(false)
  }, [open, calendars])

  const submit = async (): Promise<void> => {
    if (!file) {
      setError(t('calendar.import.content_required'))
      return
    }
    if (mode === 'existing' && !targetId) {
      setError(t('calendar.calendar.target_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const content = await file.text()
      const result = await api.importIcs({
        content,
        ...(mode === 'existing' ? { targetCalendarId: targetId } : { newCalendar: { name: newName.trim() || file.name.replace(/\.ics$/i, ''), color } }),
        defaultTimeZone,
      })
      useUi.getState().toast({
        title: t('calendar.import.done', { count: result.imported }),
        description: result.warnings?.length ? t('calendar.import.warnings', { count: result.warnings.length }) : undefined,
        tone: 'success',
      })
      await onSaved()
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, 'calendar.import.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.import.title')}
      description={t('calendar.import.description')}
      width={460}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {saving ? t('calendar.import.importing') : t('calendar.sidebar.import')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4 pt-1">
        <Field label={t('calendar.import.file')} hint={t('calendar.import.file_hint')} required>
          <input
            type="file"
            accept=".ics,text/calendar"
            data-autofocus
            aria-label={t('calendar.import.file')}
            className="block w-full text-[length:var(--text-12)] text-[var(--text-secondary)] file:mr-2 file:cursor-pointer file:rounded-[var(--r-sm)] file:border file:border-[var(--border-default)] file:bg-[var(--bg-raised)] file:px-2.5 file:py-1.5 file:text-[length:var(--text-12)] file:font-medium file:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null
              setError(null)
              if (picked && picked.size > MAX_ICS_BYTES) {
                setFile(null)
                setError(t('calendar.import.too_large'))
                return
              }
              if (picked && !isIcsFile(picked)) {
                setFile(null)
                setError(t('calendar.import.invalid'))
                return
              }
              setFile(picked)
            }}
          />
        </Field>

        <Field label={t('calendar.import.target')}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={calendars.length > 0
              ? [
                  { value: 'existing', label: t('calendar.import.existing') },
                  { value: 'new', label: t('calendar.import.new_calendar') },
                ]
              : [{ value: 'new', label: t('calendar.import.new_calendar') }]}
          />
        </Field>

        {mode === 'existing'
          ? (
              <Field label={t('calendar.import.existing')}>
                <Select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                  {calendars.map(calendar => (
                    <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
                  ))}
                </Select>
              </Field>
            )
          : (
              <>
                <Field label={t('calendar.import.new_name')}>
                  <Input
                    value={newName}
                    maxLength={80}
                    placeholder={t('calendar.import.new_name_placeholder')}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </Field>
                <Field label={t('calendar.calendar.color')}>
                  <div><ColorPresets value={color} onChange={setColor} /></div>
                </Field>
              </>
            )}
        {error && <DialogError>{error}</DialogError>}
      </div>
    </Modal>
  )
}

type SubscribeDialogProps = DialogBaseProps

export function SubscribeDialog({ open, onClose, onSaved }: SubscribeDialogProps) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(CALENDAR_COLOR_PRESETS[5])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setName('')
    setColor(CALENDAR_COLOR_PRESETS[5])
    setError(null)
    setSaving(false)
  }, [open])

  const submit = async (): Promise<void> => {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setError(t('calendar.subscription.invalid_url'))
      return
    }
    if (parsed.protocol !== 'https:') {
      setError(t('calendar.subscription.invalid_url'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.createSubscription({
        url: parsed.toString(),
        ...(name.trim() ? { name: name.trim() } : {}),
        color,
      })
      useUi.getState().toast({ title: t('calendar.subscription.done'), tone: 'success' })
      await onSaved()
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, 'calendar.subscription.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.subscription.title')}
      description={t('calendar.subscription.description')}
      width={460}
      dismissible={!saving}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {saving ? t('calendar.subscription.working') : t('calendar.subscription.subscribe')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4 pt-1">
        <Field label={t('calendar.subscription.url')} hint={t('calendar.subscription.url_hint')} required>
          <Input
            data-autofocus
            type="url"
            inputMode="url"
            value={url}
            placeholder="https://example.com/calendar.ics"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </Field>
        <Field label={t('calendar.subscription.name')}>
          <Input
            value={name}
            maxLength={80}
            placeholder={t('calendar.subscription.name_placeholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t('calendar.calendar.color')}>
          <div><ColorPresets value={color} onChange={setColor} /></div>
        </Field>
        {error && <DialogError>{error}</DialogError>}
      </div>
    </Modal>
  )
}
