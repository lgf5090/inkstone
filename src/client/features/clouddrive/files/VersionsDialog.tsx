import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { Button, Spinner } from '../../../components/primitives'
import { confirm, Modal } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { clouddriveApi } from '../api'

const VERSION_KEEP = 10

interface VersionView {
  version: number
  size: number
  mime: string
  createdAt: number
}

export interface VersionsDialogProps {
  open: boolean
  entry: CloudDriveEntry | null
  onClose: () => void
  onRestored: (entry: CloudDriveEntry) => void
}

export function VersionsDialog({ open, entry, onClose, onRestored }: VersionsDialogProps) {
  const toast = useUi((state) => state.toast)
  const [versions, setVersions] = useState<VersionView[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busyVersion, setBusyVersion] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!entry) return
    setStatus('loading')
    try {
      const result = await clouddriveApi.versions(entry.id)
      setVersions(result.versions)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [entry])

  useEffect(() => {
    if (open && entry) void load()
  }, [open, entry, load])

  const restore = async (version: number) => {
    if (!entry) return
    setBusyVersion(version)
    try {
      const result = await clouddriveApi.restoreVersion(entry.id, version)
      onRestored(result.entry)
      toast({ title: t('clouddrive.versions.restored') })
      await load()
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally {
      setBusyVersion(null)
    }
  }

  const remove = async (version: number) => {
    if (!entry) return
    if (!(await confirm({ title: t('clouddrive.versions.delete'), tone: 'danger' }))) return
    setBusyVersion(version)
    try {
      await clouddriveApi.deleteVersion(entry.id, version)
      toast({ title: t('clouddrive.versions.deleted') })
      await load()
    } catch (caught) {
      toast({ title: t('clouddrive.toast.failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('clouddrive.versions.title')}
      width={480}
      footer={<Button variant="ghost" onClick={onClose}>{t('clouddrive.dialog.cancel')}</Button>}
    >
      <div className="flex flex-col gap-2">
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('clouddrive.versions.description', { count: VERSION_KEEP })}
        </p>
        {status === 'loading' && <div className="flex h-20 items-center justify-center"><Spinner /></div>}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-2 py-4">
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
          </div>
        )}
        {status === 'ready' && versions.length === 0 && (
          <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.versions.empty')}</p>
        )}
        {versions.length > 0 && (
          <ul className="flex flex-col gap-1">
            {versions.map((version) => (
              <li key={version.version} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-1.5">
                <span className="rounded-full bg-[var(--bg-inset)] px-2 py-0.5 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{`v${version.version}`}</span>
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">
                  {new Date(version.createdAt).toLocaleString()} · {formatBytes(version.size)}
                </span>
                <Button size="sm" variant="ghost" disabled={busyVersion !== null} onClick={() => void restore(version.version)}>
                  <RotateCcw size={13} /> {t('clouddrive.versions.restore')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busyVersion !== null} onClick={() => void remove(version.version)}>
                  <Trash2 size={13} /> {t('clouddrive.versions.delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
