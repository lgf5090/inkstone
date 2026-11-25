import { useEffect, useState } from 'react'
import { Download, Star } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import type { MessageKey } from '@shared/locales/en-US'
import { Button, Spinner } from '../../../components/primitives'
import { clouddriveApi, cloudDriveErrorKey } from '../api'
import { useCloudDriveStore } from '../store'

export function QuickFilesPage({ mode }: { mode: 'recent' | 'starred' }) {
  const [files, setFiles] = useState<CloudDriveEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<MessageKey | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const refreshKey = useCloudDriveStore((state) => state.refreshKey)
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    const work = mode === 'recent'
      ? clouddriveApi.recent('viewed').then((result) => result.files)
      : clouddriveApi.recent('starred').then((result) => result.files)
    void work
      .then((result) => {
        if (cancelled) return
        setFiles(result)
        setStatus('ready')
      })
      .catch((caught) => {
        if (cancelled) return
        setFiles([])
        setError(cloudDriveErrorKey(caught) as MessageKey)
        setStatus('error')
      })
    return () => { cancelled = true }
  }, [mode, refreshKey, retryKey])
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <h1 className="mb-3 flex items-center gap-2 text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{mode === 'recent' ? t('clouddrive.nav.recent') : t('clouddrive.nav.starred')}{mode === 'starred' && <Star size={14} className="text-[var(--accent)]" />}</h1>
      {status === 'loading' ? (
        <div role="status" aria-live="polite" className="flex h-32 items-center justify-center gap-2 text-[var(--text-tertiary)]"><Spinner />{t('clouddrive.loading')}</div>
      ) : status === 'error' ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{error && t(error)}</p>
          <Button variant="secondary" onClick={() => setRetryKey((key) => key + 1)}>{t('clouddrive.retry')}</Button>
        </div>
      ) : files.length === 0 ? <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{mode === 'recent' ? t('clouddrive.empty.recent') : t('clouddrive.empty.starred')}</p> : (
        <ul className="flex flex-col gap-1.5">
          {files.map((file) => (
            <li key={file.id} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{file.name}</span>
              <span className="min-w-0 max-w-[240px] truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{file.path}</span>
              <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{formatBytes(file.size)}</span>
              <a className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" href={clouddriveApi.contentUrl(file.id, true)} aria-label={t('clouddrive.action.download')}><Download size={13} /></a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
