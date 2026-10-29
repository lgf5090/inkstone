import { useEffect, useState, type FormEvent } from 'react'
import { HardDrive, LockKeyhole } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Input } from '../../../components/form'
import { Button, Spinner } from '../../../components/primitives'

interface ShareMeta {
  name: string
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

export function DriveSharePage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
                {meta.targetKind === 'folder' ? t('clouddrive.nav.files') : meta.mime ?? ''}
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
          </div>
        )}
      </section>
    </main>
  )
}
