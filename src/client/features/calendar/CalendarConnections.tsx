import { useEffect, useState, type ReactNode } from 'react'
import { Link2, Trash2 } from 'lucide-react'
import type { CalendarConnectionDto } from '@shared/calendar/model'
import { t, useLocaleRepaint } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { confirm, Modal } from '../../components/overlay'
import { Input, Select, SettingRow, Switch } from '../../components/form'
import { useUi } from '../../store/ui'
import * as api from './api'

interface CalendarConnectionsProps {
  open: boolean
  onClose: () => void
  connections: readonly CalendarConnectionDto[]
  onChanged: () => Promise<void>
}

type Preset = api.CalDavConnectionInput['preset']


function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{hint}</span>}
    </label>
  )
}

function statusLabel(status: CalendarConnectionDto['status']): string {
  if (status === 'connected') return t('calendar.connections.status_connected')
  if (status === 'error') return t('calendar.connections.status_error')
  if (status === 'expired') return t('calendar.connections.status_expired')
  return t('calendar.connections.status_disconnected')
}

export function CalendarConnections({ open, onClose, connections, onChanged }: CalendarConnectionsProps) {
  useLocaleRepaint()
  const presets: Array<{ value: Preset; label: string }> = [
    { value: 'icloud', label: 'iCloud' },
    { value: 'nextcloud', label: 'Nextcloud' },
    { value: 'radicale', label: 'Radicale' },
    { value: 'fastmail', label: 'Fastmail' },
    { value: 'custom', label: t('calendar.connections.preset_custom') },
  ]
  const [preset, setPreset] = useState<Preset>('nextcloud')
  const [label, setLabel] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [writable, setWritable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oauthBusy, setOauthBusy] = useState<'google' | 'outlook' | null>(null)

  useEffect(() => {
    if (!open) return
    setLabel('')
    setServerUrl('')
    setUsername('')
    setPassword('')
    setWritable(false)
    setSaving(false)
    setError(null)
    setOauthBusy(null)
  }, [open])

  const addCalDav = async (): Promise<void> => {
    if (!username.trim() || !password) {
      setError(t('calendar.connections.credentials_required'))
      return
    }
    if (preset === 'custom' && !serverUrl.trim()) {
      setError(t('calendar.connections.server_required'))
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.createCalDavConnection({
        preset,
        ...(preset === 'custom' ? { serverUrl: serverUrl.trim() } : {}),
        username: username.trim(),
        password,
        ...(label.trim() ? { label: label.trim() } : {}),
        writable,
      })
      setPassword('')
      useUi.getState().toast({ title: t('calendar.connections.added'), tone: 'success' })
      await onChanged()
    } catch (addError) {
      setError(addError instanceof Error && addError.message ? addError.message : t('calendar.connections.add_failed'))
    } finally {
      setSaving(false)
    }
  }

  const startOAuth = async (provider: 'google' | 'outlook'): Promise<void> => {
    setOauthBusy(provider)
    setError(null)
    try {
      const { url } = await api.startConnectionOAuth(provider, writable)
      window.location.assign(url)
    } catch (oauthError) {
      setError(oauthError instanceof Error && oauthError.message ? oauthError.message : t('calendar.connections.oauth_failed'))
      setOauthBusy(null)
    }
  }

  const removeConnection = async (connection: CalendarConnectionDto): Promise<void> => {
    const confirmed = await confirm({
      title: t('calendar.connections.remove_title'),
      description: t('calendar.connections.remove_body', { name: connection.label || connection.kind }),
      confirmLabel: t('calendar.connections.remove'),
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await api.deleteConnection(connection.id)
      useUi.getState().toast({ title: t('calendar.connections.removed'), tone: 'success' })
      await onChanged()
    } catch (removeError) {
      useUi.getState().toast({
        title: t('calendar.connections.remove_failed'),
        description: removeError instanceof Error ? removeError.message : undefined,
        tone: 'danger',
      })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('calendar.connections.title')}
      description={t('calendar.connections.description')}
      width={620}
      dismissible={!saving}
      footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-[length:var(--text-11)] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]">
            {t('calendar.connections.existing')}
          </h3>
          {connections.length === 0
            ? <p className="text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('calendar.connections.empty')}</p>
            : (
                <ul className="flex flex-col gap-1.5">
                  {connections.map(connection => (
                    <li key={connection.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 py-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
                        <Link2 size={13} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                          {connection.label || connection.kind}
                        </span>
                        <span className="block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                          {statusLabel(connection.status)} · {connection.writable ? t('calendar.connections.writable') : t('calendar.connections.read_only')}
                        </span>
                      </span>
                      <IconButton label={t('calendar.connections.remove')} onClick={() => void removeConnection(connection)}>
                        <Trash2 size={13} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
        </section>

        <section className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
          <h3 className="text-[length:var(--text-11)] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]">
            {t('calendar.connections.add')}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.connections.provider')}>
              <Select value={preset} onChange={event => setPreset(event.target.value as Preset)}>
                {presets.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Field>
            <Field label={t('calendar.connections.label')}>
              <Input
                value={label}
                onChange={event => setLabel(event.target.value)}
                placeholder={t('calendar.connections.label_placeholder')}
              />
            </Field>
          </div>
          {preset === 'custom' && (
            <Field label={t('calendar.connections.server')} hint={t('calendar.connections.server_hint')}>
              <Input
                type="url"
                value={serverUrl}
                onChange={event => setServerUrl(event.target.value)}
                placeholder="https://calendar.example.com/"
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('calendar.connections.username')}>
              <Input
                autoComplete="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
              />
            </Field>
            <Field label={t('calendar.connections.password')} hint={t('calendar.connections.password_hint')}>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </Field>
          </div>
          <SettingRow title={t('calendar.connections.allow_write')} description={t('calendar.connections.allow_write_hint')}>
            <Switch checked={writable} onChange={setWritable} label={t('calendar.connections.allow_write')} />
          </SettingRow>
          {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={saving} onClick={() => void addCalDav()}>
              {t('calendar.connections.connect_caldav')}
            </Button>
            <Button variant="secondary" loading={oauthBusy === 'google'} onClick={() => void startOAuth('google')}>
              {t('calendar.connections.connect_google')}
            </Button>
            <Button variant="secondary" loading={oauthBusy === 'outlook'} onClick={() => void startOAuth('outlook')}>
              {t('calendar.connections.connect_outlook')}
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
