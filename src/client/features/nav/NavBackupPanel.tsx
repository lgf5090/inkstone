import { useEffect, useState } from 'react'
import { AlertCircle, Check, CloudUpload, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { NavBackupConfig, NavBackupSchedule } from '@shared/nav/model'
import { Modal, confirm } from '../../components/overlay'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, SettingRow } from '../../components/form'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { useRelativeTime } from '../../lib/hooks'
import { cn } from '../../lib/cn'
import { navApi } from './api'
import { useNavStore } from './nav-store'

interface ModalProps {
  open: boolean
  onClose: () => void
}

const WEBDAV_PRESETS = [
  { label: 'Jianguoyun', url: 'https://dav.jianguoyun.com/dav/' },
  { label: 'InfiniCLOUD', url: 'https://domi.teracloud.jp/dav/' },
  { label: 'Nextcloud', url: 'https://your-host/remote.php/dav/files/username/' },
  { label: 'Synology', url: 'https://your-host:5006/' },
  { label: 'Box', url: 'https://dav.box.com/dav/' },
]

type BackupStatus = { kind: 'idle' } | { kind: 'loading'; text: string } | { kind: 'success'; text: string } | { kind: 'error'; text: string }

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('nav.error.generic')
}

function webdavTestMessage(message: string | undefined): string {
  const text = message ?? ''
  if (/incorrect username|password/i.test(text)) return t('nav.backup.test_error.auth')
  if (/path does not exist|path not found/i.test(text)) return t('nav.backup.test_error.path_missing')
  if (/write access is missing/i.test(text)) return t('nav.backup.test_error.write_forbidden')
  if (/read access is missing/i.test(text)) return t('nav.backup.test_error.read_forbidden')
  if (/out of storage/i.test(text)) return t('nav.backup.test_error.storage')
  if (/redirect/i.test(text)) return t('nav.backup.test_error.redirect')
  if (/publicly reachable/i.test(text)) return t('nav.backup.test_error.connect')
  if (/could not connect|connection|network/i.test(text)) return t('nav.backup.test_error.connect')
  return t('nav.backup.test_error.generic')
}

const FREQUENCIES: NavBackupSchedule[] = ['off', 'hourly', 'sixHourly', 'daily', 'weekly']
const RETENTIONS = [0, 7, 14, 30, 90, 365]

function frequencyLabel(frequency: NavBackupSchedule): string {
  if (frequency === 'off') return t('nav.backup.frequency.off')
  if (frequency === 'hourly') return t('nav.backup.frequency.hourly')
  if (frequency === 'sixHourly') return t('nav.backup.frequency.six_hourly')
  if (frequency === 'daily') return t('nav.backup.frequency.daily')
  return t('nav.backup.frequency.weekly')
}

export function NavBackupModal({ open, onClose }: ModalProps) {
  const toast = useUi((state) => state.toast)
  const [config, setConfig] = useState<NavBackupConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<BackupStatus>({ kind: 'idle' })
  const lastRun = useRelativeTime(config?.lastRunAt ?? 0, Boolean(config?.lastRunAt))
  const configured = Boolean(config?.url && config.username && config.hasPassword)

  useEffect(() => {
    if (!open) return
    setStatus({ kind: 'idle' })
    void refresh()
  }, [open])

  async function refresh(): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await navApi.backupConfig()
      setConfig(next)
      setUrl(next.url)
      setUsername(next.username)
      setPassword('')
      setEditing(!next.url || !next.username || !next.hasPassword)
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  function beginEdit(): void {
    setUrl(config?.url ?? '')
    setUsername(config?.username ?? '')
    setPassword('')
    setStatus({ kind: 'idle' })
    setEditing(true)
  }

  function cancelEdit(): void {
    if (!configured) {
      onClose()
      return
    }
    setUrl(config!.url)
    setUsername(config!.username)
    setPassword('')
    setStatus({ kind: 'idle' })
    setEditing(false)
  }

  async function saveConnection(): Promise<void> {
    if (!url.trim() || !username.trim()) {
      setStatus({ kind: 'error', text: t('nav.backup.required') })
      return
    }
    if (!config?.hasPassword && !password.trim()) {
      setStatus({ kind: 'error', text: t('nav.backup.password_required') })
      return
    }
    setBusy(true)
    setStatus({ kind: 'loading', text: t('nav.save') })
    try {
      const next = await navApi.saveBackupConfig({
        url: url.trim(),
        username: username.trim(),
        ...(password.trim() ? { password: password.trim() } : {}),
      })
      setConfig(next)
      setPassword('')
      setEditing(false)
      setStatus({ kind: 'success', text: t('nav.backup.saved') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    setBusy(true)
    setStatus({ kind: 'loading', text: t('nav.backup.testing') })
    try {
      const result = await navApi.webdavTest(editing
        ? { url: url.trim(), username: username.trim(), ...(password.trim() ? { password: password.trim() } : {}) }
        : {})
      setStatus(result.ok
        ? { kind: 'success', text: t('nav.backup.test_ok') }
        : { kind: 'error', text: webdavTestMessage(result.error) })
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function backupNow(): Promise<void> {
    setBusy(true)
    setStatus({ kind: 'loading', text: t('nav.backup.running') })
    try {
      const result = await navApi.webdavBackup({ timestamped: true })
      await refresh()
      setStatus({ kind: 'success', text: t('nav.backup.backup_ok', { name: result.filename }) })
      toast({ title: t('nav.backup.backup_ok', { name: result.filename }), tone: 'success' })
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function restoreLatest(): Promise<void> {
    if (!(await confirm({
      title: t('nav.backup.restore_confirm'),
      description: t('nav.backup.restore_locked_hint'),
      confirmLabel: t('nav.backup.restore'),
      tone: 'danger',
    }))) return
    setBusy(true)
    setStatus({ kind: 'loading', text: t('nav.backup.restoring') })
    try {
      const result = await navApi.webdavRestore({})
      setStatus({ kind: 'success', text: t('nav.backup.restored') })
      toast({
        title: t('nav.backup.restored'),
        description: result.unlockedCategoryNames.length
          ? t('nav.webdav.unlocked', { names: result.unlockedCategoryNames.join(', ') })
          : undefined,
        tone: 'success',
      })
      await useNavStore.getState().load(true)
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function removeTarget(): Promise<void> {
    if (!(await confirm({
      title: t('nav.backup.remove_confirm'),
      confirmLabel: t('nav.backup.remove'),
      tone: 'danger',
    }))) return
    setBusy(true)
    try {
      await navApi.webdavForget()
      await refresh()
      setStatus({ kind: 'success', text: t('nav.backup.removed') })
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  async function updateSetting(patch: { schedule?: NavBackupSchedule; retention?: number }): Promise<void> {
    if (!config) return
    setBusy(true)
    try {
      const next = await navApi.saveBackupConfig(patch)
      setConfig(next)
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nav.backup.title')}
      width={640}
      dismissible={!busy}
      footer={<Button variant="ghost" onClick={onClose} disabled={busy}>{t('nav.close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        {loading && !config ? (
          <p className="flex items-center gap-2 py-6 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Loader2 size={13} className="animate-spin" /> {t('nav.loading')}
          </p>
        ) : loadError && !config ? (
          <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3 text-[length:var(--text-12)] text-[var(--danger)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{loadError}</span>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>{t('nav.retry')}</Button>
          </div>
        ) : (
          <>
            <section className="flex items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <span className="mt-0.5 text-[var(--accent)]"><CloudUpload size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                  {configured ? t('nav.backup.target_active') : t('nav.backup.no_target')}
                </div>
                <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
                  {configured
                    ? config!.lastStatus === 'success'
                      ? `${t('nav.backup.last_success')}${config!.lastRunAt ? ` · ${lastRun}` : ''}`
                      : config!.lastStatus === 'failed'
                        ? `${t('nav.backup.last_failed')}${config!.lastRunAt ? ` · ${lastRun}` : ''}`
                        : t('nav.backup.never')
                    : t('nav.backup.no_target_hint')}
                </p>
              </div>
              <Button size="sm" variant="primary" loading={busy && status.kind === 'loading'} disabled={!configured || busy || editing} onClick={() => void backupNow()}>
                {t('nav.backup.now')}
              </Button>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[length:var(--text-11)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('nav.backup.target')}</h3>
                {configured && !editing && (
                  <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('nav.backup.saved_credentials')}</span>
                )}
              </div>
              {editing ? (
                <form
                  className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void saveConnection()
                  }}
                >
                  <Field label={t('nav.backup.url')}>
                    <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://dav.example.com/" autoComplete="url" />
                  </Field>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('nav.backup.preset')}</span>
                    {WEBDAV_PRESETS.map((preset) => (
                      <Button key={preset.label} type="button" size="sm" variant="ghost" onClick={() => setUrl(preset.url)}>{preset.label}</Button>
                    ))}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('nav.backup.username')}>
                      <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
                    </Field>
                    <Field label={t('nav.backup.password')}>
                      <Input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        placeholder={config?.hasPassword ? t('nav.backup.password_saved') : ''}
                      />
                    </Field>
                  </div>
                  <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('nav.backup.password_hint')}</p>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={cancelEdit} disabled={busy}>{t('nav.cancel')}</Button>
                    <Button type="button" variant="secondary" onClick={() => void testConnection()} disabled={busy} loading={busy && status.kind === 'loading'}>
                      {t('nav.backup.test')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={busy}>{t('nav.save')}</Button>
                  </div>
                </form>
              ) : configured ? (
                <div className="flex items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-inset)] text-[var(--text-secondary)]"><CloudUpload size={16} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('nav.backup.webdav')}</span>
                      <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('nav.backup.configured')}</span>
                    </div>
                    <p className="mt-0.5 min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{config!.url}</p>
                    <p className={cn('mt-1 flex items-center gap-1 text-[length:var(--text-11)]', config!.lastStatus === 'failed' ? 'text-[var(--danger)]' : config!.lastStatus === 'success' ? 'text-[var(--success)]' : 'text-[var(--text-quaternary)]')}>
                      {config!.lastStatus === 'success' && <Check size={12} />}
                      {config!.lastStatus === 'failed' && <AlertCircle size={12} />}
                      {config!.lastStatus === 'success'
                        ? `${t('nav.backup.last_success')}${lastRun ? ` · ${lastRun}` : ''}`
                        : config!.lastStatus === 'failed'
                          ? `${t('nav.backup.last_failed')}${lastRun ? ` · ${lastRun}` : ''}`
                          : t('nav.backup.never')}
                    </p>
                    {config!.lastError && config!.lastStatus === 'failed' && (
                      <p className="mt-1 break-words text-[length:var(--text-10-5)] text-[var(--danger)]">{config!.lastError}</p>
                    )}
                    {config!.lastFilename && (
                      <p className="mt-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('nav.backup.last_file', { name: config!.lastFilename })}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button size="sm" variant="secondary" onClick={() => void testConnection()} disabled={busy}>{t('nav.backup.test')}</Button>
                    <IconButton label={t('nav.edit')} onClick={beginEdit} disabled={busy}><Pencil size={13} /></IconButton>
                    <IconButton label={t('nav.backup.remove')} className="text-[var(--danger)]" onClick={() => void removeTarget()} disabled={busy}><Trash2 size={13} /></IconButton>
                  </div>
                </div>
              ) : (
                <p className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] p-4 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                  {t('nav.backup.no_target_hint')}
                </p>
              )}
            </section>

            <section>
              <h3 className="mb-1 text-[length:var(--text-11)] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('nav.backup.auto')}</h3>
              <SettingRow title={t('nav.backup.frequency')} description={t('nav.backup.frequency_hint')}>
                <Select
                  aria-label={t('nav.backup.frequency')}
                  className="min-w-36"
                  value={config?.schedule ?? 'off'}
                  disabled={!configured || busy || editing}
                  onChange={(event) => void updateSetting({ schedule: event.target.value as NavBackupSchedule })}
                >
                  {FREQUENCIES.map((frequency) => (
                    <option key={frequency} value={frequency}>{frequencyLabel(frequency)}</option>
                  ))}
                </Select>
              </SettingRow>
              <SettingRow title={t('nav.backup.retention')} description={t('nav.backup.retention_hint')}>
                <Select
                  aria-label={t('nav.backup.retention')}
                  className="min-w-36"
                  value={config?.retention ?? 0}
                  disabled={!configured || busy || editing}
                  onChange={(event) => void updateSetting({ retention: Number(event.target.value) })}
                >
                  {RETENTIONS.map((count) => (
                    <option key={count} value={count}>{count === 0 ? t('nav.backup.retention_all') : t('nav.backup.retention_n', { count })}</option>
                  ))}
                </Select>
              </SettingRow>
              <p className="px-1 pt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('nav.backup.cron_hint')}</p>
            </section>

            {configured && (
              <section className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-3">
                <div className="min-w-0">
                  <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('nav.backup.restore_hint')}</p>
                  <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('nav.backup.hidden_hint')}</p>
                </div>
                <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} disabled={busy || !(config?.lastFilename || config?.history?.length)} onClick={() => void restoreLatest()}>
                  {t('nav.backup.restore')}
                </Button>
              </section>
            )}
          </>
        )}

        {status.kind !== 'idle' && (
          <div className={cn(
            'flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)]',
            status.kind === 'error' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : status.kind === 'success' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]',
          )}>
            {status.kind === 'loading' && <Loader2 size={13} className="animate-spin" />}
            {status.kind === 'success' && <Check size={13} />}
            {status.kind === 'error' && <AlertCircle size={13} />}
            <span className="min-w-0 flex-1">{status.text}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
