import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi, type CloudDriveBackupStatus, type CloudDriveSnapshot } from '../api'

export function BackupsPage() {
  const toast = useUi((state) => state.toast)
  const [snapshots, setSnapshots] = useState<CloudDriveSnapshot[]>([])
  const [backup, setBackup] = useState<CloudDriveBackupStatus | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [hours, setHours] = useState('24')

  const load = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const [snapshotResult, backupResult] = await Promise.all([clouddriveApi.snapshots(), clouddriveApi.backupStatus()])
      setSnapshots(snapshotResult.snapshots)
      setBackup(backupResult.backup)
      setHours(String(backupResult.backup.intervalSec / 3600))
      setStatus('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('error')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (automatic: boolean) => {
    setBusy(true)
    try {
      if (automatic) await clouddriveApi.runBackup()
      else {
        await clouddriveApi.createSnapshot(name.trim())
        setOpen(false)
        setName('')
      }
      await load()
      toast({ title: t('clouddrive.backups.done') })
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const saveSchedule = async () => {
    const intervalSec = Number(hours) * 3600
    setBusy(true)
    try {
      await clouddriveApi.updateBackupSchedule({ enabled: backup?.enabled ?? true, intervalSec })
      await load()
      toast({ title: t('clouddrive.settings.saved') })
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const toggleSchedule = async () => {
    if (!backup) return
    setBusy(true)
    try {
      await clouddriveApi.updateBackupSchedule({ enabled: !backup.enabled, intervalSec: backup.intervalSec })
      await load()
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const restore = async (snapshot: CloudDriveSnapshot) => {
    if (!(await confirm({
      title: t('clouddrive.backups.restore_title'),
      description: t('clouddrive.backups.restore_body', { name: snapshot.name }),
      tone: 'danger',
    }))) return
    setBusy(true)
    try {
      const result = await clouddriveApi.restoreSnapshot(snapshot.id)
      await load()
      toast({ title: t('clouddrive.backups.restored', { count: result.restored, skipped: result.skipped }), tone: result.skipped ? 'danger' : 'success' })
    } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  const remove = async (snapshot: CloudDriveSnapshot) => {
    if (!(await confirm({ title: t('clouddrive.backups.delete_title'), description: snapshot.name, tone: 'danger' }))) return
    setBusy(true)
    try { await clouddriveApi.deleteSnapshot(snapshot.id); await load() } catch (caught) {
      toast({ title: t('clouddrive.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.backups.title')}</h1>
          <p className="mt-0.5 text-[var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('clouddrive.backups.description')}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(true)}>{t('clouddrive.backups.run')}</Button>
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={13} /> {t('clouddrive.backups.create')}</Button>
      </div>
      {backup && (
        <section className="mb-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3" aria-labelledby="backup-schedule">
          <h2 id="backup-schedule" className="text-[length:var(--text-13)] font-medium">{t('clouddrive.backups.schedule')}</h2>
          <p className="mt-1 text-[var(--text-11)] text-[var(--text-tertiary)]">{backup.note}</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label={t('clouddrive.backups.interval')}>
              <Input type="number" min={6} max={720} value={hours} onChange={(event) => setHours(event.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void saveSchedule()}>{t('clouddrive.dialog.save')}</Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void toggleSchedule()}>
              {backup.enabled ? t('clouddrive.backups.disable') : t('clouddrive.backups.enable')}
            </Button>
          </div>
        </section>
      )}
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && <div role="alert" className="p-6 text-center"><p className="text-[var(--danger)]">{error}</p><Button className="mt-3" onClick={() => void load()}>{t('clouddrive.retry')}</Button></div>}
      {status === 'ready' && snapshots.length === 0 && <p className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] p-8 text-center text-[var(--text-tertiary)]">{t('clouddrive.backups.empty')}</p>}
      <ul className="flex flex-col gap-2">
        {snapshots.map((snapshot) => (
          <li key={snapshot.id} className="flex flex-wrap items-center gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
            <div className="min-w-0 flex-1">
              <strong className="text-[length:var(--text-13)]">{snapshot.name}</strong>
              <p className="mt-0.5 text-[var(--text-10)] text-[var(--text-tertiary)]">{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.itemCount} · {formatBytes(snapshot.totalBytes)}</p>
            </div>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void restore(snapshot)}><ArchiveRestore size={13} /> {t('clouddrive.backups.restore')}</Button>
            <IconButton label={t('clouddrive.backups.delete')} disabled={busy} onClick={() => void remove(snapshot)}><Trash2 size={13} /></IconButton>
          </li>
        ))}
      </ul>
      <Modal open={open} onClose={() => setOpen(false)} title={t('clouddrive.backups.create')} width={440} footer={(
        <><Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void run(false)}>{t('clouddrive.dialog.save')}</Button></>
      )}>
        <Field label={t('clouddrive.backups.name')}><Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
      </Modal>
    </div>
  )
}
