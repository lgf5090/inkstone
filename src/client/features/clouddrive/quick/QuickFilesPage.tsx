import { useEffect, useState } from 'react'
import { Download, Star } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Spinner } from '../../../components/primitives'
import { clouddriveApi } from '../api'

export function QuickFilesPage({ mode }: { mode: 'recent' | 'starred' }) {
  const [files, setFiles] = useState<CloudDriveEntry[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const work = mode === 'recent'
      ? clouddriveApi.recent('viewed').then((result) => result.files)
      : clouddriveApi.list({ mountId: 'primary', path: '/', starred: true }).then((result) => result.files)
    void work.then((result) => { if (!cancelled) setFiles(result) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [mode])
  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <h1 className="mb-3 flex items-center gap-2 text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{mode === 'recent' ? t('clouddrive.nav.recent') : t('clouddrive.nav.starred')}{mode === 'starred' && <Star size={14} className="text-[var(--accent)]" />}</h1>
      {loading ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : files.length === 0 ? <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{mode === 'recent' ? t('clouddrive.empty.recent') : t('clouddrive.empty.starred')}</p> : (
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
