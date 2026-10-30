import { useEffect, useState, type FormEvent } from 'react'
import { HardDrive, LockKeyhole } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Input } from '../../../components/form'
import { Button, Spinner } from '../../../components/primitives'

interface ShareMeta {
  name: string
  path: string
  targetKind: 'file' | 'folder'
  size?: number | null
  mime?: string | null
  locked: boolean
  hasPassword: boolean
  expiresAt?: number | null
  allowDownload: boolean
  disabled: boolean
}

type Phase = 'loading' | 'ready' | 'locked' | 'unavailable' | 'expired'
type ShareEntry = { name: string; path: string; kind: 'file' | 'folder'; size: number; mime: string; modifiedAt: number }

export function DriveSharePage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [entries, setEntries] = useState<ShareEntry[]>([])
  const [sharePath, setSharePath] = useState('/')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/clouddrive/shares/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return await response.json() as ShareMeta
      })
      .then((value) => {
        if (cancelled) return
        setMeta(value)
        setSharePath(value.path || '/')
        setPhase(value.disabled ? 'unavailable' : value.locked ? 'locked' : 'ready')
      })
      .catch(() => {
        if (!cancelled) setPhase('unavailable')
      })
    return () => { cancelled = true }
  }, [slug])

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(`/api/public/clouddrive/shares/${encodeURIComponent(slug)}/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Inkstone-Client': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (response.status === 401 || response.status === 403) {
        setError(t('clouddrive.error.share_locked'))
        return
      }
      if (!response.ok) {
        setPhase(response.status === 404 ? 'expired' : 'unavailable')
        return
      }
      setPhase('ready')
    } catch {
      setError(t('clouddrive.error.internal'))
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (phase !== 'ready' || meta?.targetKind !== 'folder') return
    let cancelled = false
    fetch(`/api/public/clouddrive/shares/${encodeURIComponent(slug)}/list?path=${encodeURIComponent(sharePath)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return await response.json() as { entries: ShareEntry[] }
      })
      .then((value) => { if (!cancelled) setEntries(value.entries) })
      .catch(() => { if (!cancelled) setEntries([]) })
    return () => { cancelled = true }
  }, [phase, meta?.targetKind, sharePath, slug])

  return (
    <main className="cd-share-page flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-4">
      <section className="w-full max-w-[560px] rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-pop)]">
        <header className="mb-4 flex items-center gap-2 text-[var(--text-secondary)]">
          <HardDrive size={18} aria-hidden />
          <span className="text-[length:var(--text-12)] font-medium tracking-wide">{t('clouddrive.title')}</span>
        </header>
        {phase === 'loading' && (
          <div className="flex items-center justify-center py-12"><Spinner /></div>
        )}
        {phase === 'unavailable' && (
          <p role="status" className="py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('clouddrive.share.unavailable')}</p>
        )}
        {phase === 'expired' && (
          <p role="status" className="py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('clouddrive.share.expired')}</p>
        )}
        {phase === 'locked' && (
          <form onSubmit={unlock} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <LockKeyhole size={16} className="text-[var(--text-tertiary)]" aria-hidden />
              <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.share.locked')}</h1>
            </div>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-label={t('clouddrive.share.password_label')}
              placeholder={t('clouddrive.share.password_label')}
              autoFocus
            />
            {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
            <Button type="submit" variant="primary" disabled={submitting}>{t('clouddrive.share.unlock')}</Button>
          </form>
        )}
        {phase === 'ready' && meta && (
          <div className="flex flex-col gap-4">
            <div>
              <h1 className="truncate text-[length:var(--text-17)] font-semibold text-[var(--text-primary)]">{meta.name}</h1>
              <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {meta.targetKind === 'folder' ? t('clouddrive.share.folder') : meta.mime ?? ''}
              </p>
            </div>
            {meta.targetKind === 'file' && meta.allowDownload && (
              <a
                className="inline-flex h-9 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent)] px-4 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)]"
                href={`/d/${encodeURIComponent(slug)}/raw`}
              >
                {t('clouddrive.share.download')}
              </a>
            )}
            {meta.targetKind === 'file' && !meta.allowDownload && (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.no_download')}</p>
            )}
            {meta.targetKind === 'folder' && (
              <div className="flex flex-col gap-1">
                {sharePath !== '/' && <button type="button" className="self-start text-[length:var(--text-11)] text-[var(--accent)]" onClick={() => setSharePath(sharePath.slice(0, Math.max(1, sharePath.lastIndexOf('/'))) || '/')}>{t('clouddrive.toolbar.back')}</button>}
                {entries.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.folder_empty')}</p>}
                {entries.map((entry) => (
                  <div key={entry.path} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                    {entry.kind === 'folder'
                      ? <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]" onClick={() => setSharePath(entry.path)}>{entry.name}</button>
                      : <a className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]" href={`/d/${encodeURIComponent(slug)}/raw?path=${encodeURIComponent(entry.path)}`} download>{entry.name}</a>}
                    {entry.kind === 'file' && <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{formatBytes(entry.size)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
