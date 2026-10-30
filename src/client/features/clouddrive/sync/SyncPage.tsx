import { useEffect, useMemo, useState } from 'react'
import { FolderSync, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Field, Input } from '../../../components/form'
import { confirm, Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi, type CloudDriveSyncTarget } from '../api'
import { directoryPickerAvailable, pickMirrorDirectory, runMirror, type MirrorProgress } from './engine'

export function SyncPage() {
  const toast = useUi((state) => state.toast)
  const [targets, setTargets] = useState<CloudDriveSyncTarget[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', localLabel: '', remotePath: '/' })
  const [busy, setBusy] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [progress, setProgress] = useState<MirrorProgress | null>(null)
  const [truncatedId, setTruncatedId] = useState<string | null>(null)
  const supported = useMemo(() => directoryPickerAvailable(), [])

  const load = async () => {
    setStatus('loading')
    setError(null)
    try {
      const result = await clouddriveApi.syncTargets()
      setTargets(result.targets)
      setStatus('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('error')
    }
  }
  useEffect(() => { void load() }, [])

  const openCreate = () => {
    setEditId(null)
    setForm({ name: '', localLabel: '', remotePath: '/' })
    setOpen(true)
  }
  const openEdit = (target: CloudDriveSyncTarget) => {
    setEditId(target.id)
    setForm({ name: target.name, localLabel: target.localLabel, remotePath: target.remotePath })
    setOpen(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      if (editId) {
        await clouddriveApi.patchSyncTarget(editId, form)
      } else {
        await clouddriveApi.createSyncTarget(form)
      }
      setOpen(false)
      await load()
      toast({ title: t('clouddrive.settings.saved') })
    } catch (caught) {
      toast({
        title: t('clouddrive.toast.failed'),
        description: caught instanceof Error ? caught.message : '',
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (target: CloudDriveSyncTarget) => {
    if (!(await confirm({
      title: t('clouddrive.sync.delete_title'),
      description: t('clouddrive.sync.delete_body'),
      tone: 'danger',
    }))) return
    try {
      await clouddriveApi.deleteSyncTarget(target.id)
      await load()
      toast({ title: t('clouddrive.settings.saved') })
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    }
  }

  const run = async (target: CloudDriveSyncTarget) => {
    if (!supported) {
      toast({ title: t('clouddrive.sync.unsupported'), tone: 'danger' })
      return
    }
    let directory: FileSystemDirectoryHandle | null = null
    try {
      directory = await pickMirrorDirectory()
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
      return
    }
    if (!directory) return
    setRunningId(target.id)
    setProgress(null)
    setTruncatedId(null)
    try {
      const result = await runMirror({
        mountId: target.mountId,
        remoteBase: target.remotePath,
        directory,
        onProgress: setProgress,
      })
      const failed = result.failed.length
      await clouddriveApi.reportSync(target.id, {
        status: failed > 0 ? 'error' : 'success',
        files: result.uploaded,
        bytes: result.plan.bytes,
        error: failed > 0 ? `${failed} file(s) failed: ${result.failed.slice(0, 3).map((item) => item.path).join(', ')}` : undefined,
      })
      if (result.truncated) setTruncatedId(target.id)
      await load()
      toast({
        title: result.uploaded === 0 && failed === 0
          ? t('clouddrive.sync.no_changes')
          : t('clouddrive.sync.done', { uploaded: result.uploaded, failed }),
        tone: failed > 0 ? 'danger' : 'success',
      })
    } catch (caught) {
      try {
        await clouddriveApi.reportSync(target.id, {
          status: 'error',
          files: 0,
          bytes: 0,
          error: caught instanceof Error ? caught.message : String(caught),
        })
      } catch (reportError) {
        console.warn('[inkstone] CloudDrive sync failure could not be reported', reportError)
      }
      await load()
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally {
      setRunningId(null)
      setProgress(null)
    }
  }

  const progressText = (value: MirrorProgress): string => {
    if (value.phase === 'collect') return t('clouddrive.sync.collect')
    if (value.phase === 'compare') return t('clouddrive.sync.compare', { total: value.total })
    if (value.phase === 'folders') return t('clouddrive.sync.folders', { done: value.done, total: value.total })
    return t('clouddrive.sync.upload', { done: value.done, total: value.total, failed: value.failed })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.sync.title')}</h1>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('clouddrive.sync.description')}</p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
          <Button size="sm" variant="primary" onClick={openCreate}><Plus size={13} /> {t('clouddrive.sync.add')}</Button>
        </div>
      </div>
      {!supported && (
        <p role="alert" className="mb-3 rounded-[var(--r-md)] bg-[var(--warning-soft)] px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {t('clouddrive.sync.unsupported')}
        </p>
      )}
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && (
        <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
        </div>
      )}
      {status === 'ready' && targets.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] p-8 text-center">
          <FolderSync size={24} className="text-[var(--text-tertiary)]" aria-hidden />
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.sync.empty')}</p>
        </div>
      )}
      {targets.length > 0 && (
        <ul className="flex flex-col gap-2">
          {targets.map((target) => {
            const running = runningId === target.id
            return (
              <li key={target.id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FolderSync size={15} className="text-[var(--accent)]" aria-hidden />
                  <strong className="text-[length:var(--text-13)] text-[var(--text-primary)]">{target.name}</strong>
                  <span className="rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{target.remotePath}</span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{target.localLabel}</span>
                  <Button size="sm" variant="secondary" loading={running} disabled={runningId !== null} onClick={() => void run(target)}>
                    {t('clouddrive.sync.run')}
                  </Button>
                  <IconButton label={t('clouddrive.sync.edit')} onClick={() => openEdit(target)} disabled={running}><Pencil size={13} /></IconButton>
                  <IconButton label={t('clouddrive.sync.delete')} onClick={() => void remove(target)} disabled={running}><Trash2 size={13} /></IconButton>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  <span>{target.lastSyncAt
                    ? t('clouddrive.sync.last', { time: new Date(target.lastSyncAt).toLocaleString() })
                    : t('clouddrive.sync.never')}</span>
                  {target.lastSyncAt && <span>{target.lastFileCount} · {formatBytes(target.lastBytes)}</span>}
                  {target.lastStatus === 'error' && target.lastError && (
                    <span className="text-[var(--danger)]">{t('clouddrive.sync.last_failed', { error: target.lastError })}</span>
                  )}
                  {truncatedId === target.id && <span className="text-[var(--warning)]">{t('clouddrive.sync.truncated')}</span>}
                </div>
                {running && (
                  <div role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    <Spinner size={12} />
                    <span>{progress ? progressText(progress) : t('clouddrive.sync.collect')}</span>
                    {progress?.current && <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{progress.current}</span>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editId ? t('clouddrive.sync.edit') : t('clouddrive.sync.add')}
        width={460}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('clouddrive.dialog.cancel')}</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={() => void save()}>{t('clouddrive.dialog.save')}</Button>
          </>
        )}
      >
        <div className="grid gap-2">
          <Field label={t('clouddrive.sync.name')}>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label={t('clouddrive.sync.local_label')}>
            <Input value={form.localLabel} onChange={(event) => setForm({ ...form, localLabel: event.target.value })} />
          </Field>
          <Field label={t('clouddrive.sync.remote_path')} hint={t('clouddrive.sync.path_hint')}>
            <Input value={form.remotePath} onChange={(event) => setForm({ ...form, remotePath: event.target.value })} placeholder={t('clouddrive.sync.path_placeholder')} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
