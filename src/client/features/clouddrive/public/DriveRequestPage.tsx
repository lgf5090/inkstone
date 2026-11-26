import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { HardDrive, LockKeyhole, Upload } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Input } from '../../../components/form'
import { Button, Spinner } from '../../../components/primitives'
import { NON_CREDENTIAL_AUTOCOMPLETE } from '../../../lib/autocomplete'
import { CloudDriveApiError } from '../api'
import { cloudDrivePublicApi, type PublicRequestInfo } from './api'

type Phase = 'loading' | 'ready' | 'locked' | 'unavailable'

export function DriveRequestPage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [info, setInfo] = useState<PublicRequestInfo | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(() => cloudDrivePublicApi.fileRequest(slug), [slug])

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setInfo(null)
    setError('')
    void load()
      .then((value) => {
        if (cancelled) return
        setInfo(value)
        setPhase(value.hasPassword ? 'locked' : 'ready')
      })
      .catch(() => { if (!cancelled) setPhase('unavailable') })
    return () => { cancelled = true }
  }, [load])

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await cloudDrivePublicApi.verifyRequest(slug, password)
      setPhase('ready')
    } catch (caught) {
      if (caught instanceof CloudDriveApiError && caught.status === 401) {
        setError(t('clouddrive.request.locked'))
        return
      }
      if (caught instanceof CloudDriveApiError && caught.status === 429) {
        setError(t('clouddrive.error.too_many_attempts'))
        return
      }
      if (caught instanceof CloudDriveApiError) {
        setPhase('unavailable')
        return
      }
      setError(t('clouddrive.error.internal'))
    } finally {
      setSubmitting(false)
    }
  }

  const upload = async () => {
    const files = Array.from(fileInput.current?.files ?? [])
    if (files.length === 0 || !info) return
    setUploading(true)
    setError('')
    const saved: string[] = []
    try {
      for (const file of files) {
        if (info.receivedFiles + saved.length >= info.maxFiles) {
          setError(t('clouddrive.request.file_limit'))
          break
        }
        if (file.size > info.maxFileBytes) {
          setError(t('clouddrive.request.file_too_large', { size: formatBytes(info.maxFileBytes) }))
          continue
        }
        try {
          const payload = await cloudDrivePublicApi.uploadToRequest(slug, file, password)
          saved.push(payload.name ?? file.name)
        } catch (caught) {
          if (caught instanceof CloudDriveApiError && caught.status === 401) {
            setPhase('locked')
            setError(t('clouddrive.request.locked'))
            break
          }
          if (caught instanceof CloudDriveApiError && caught.status === 429) {
            setError(t('clouddrive.error.too_many_attempts'))
            break
          }
          setError(t('clouddrive.request.upload_failed'))
        }
      }
      if (saved.length > 0) {
        setDone((current) => [...saved, ...current].slice(0, 20))
        const value = await load()
        setInfo(value)
        setPhase('ready')
      }
    } catch {
      setError(t('clouddrive.request.upload_failed'))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remainingFiles = info ? Math.max(0, info.maxFiles - info.receivedFiles) : 0
  const remainingBytes = info ? Math.max(0, info.maxBytes - info.receivedBytes) : 0

  return (
    <main className="cd-share-page flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-4">
      <section className="w-full max-w-[560px] rounded-[var(--r-xl)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-pop)]">
        <header className="mb-4 flex items-center gap-2 text-[var(--text-secondary)]">
          <HardDrive size={18} aria-hidden />
          <span className="text-[length:var(--text-12)] font-medium tracking-wide">{t('clouddrive.title')}</span>
        </header>
        {phase === 'loading' && (
          <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-12 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            <Spinner /><span>{t('clouddrive.loading')}</span>
          </div>
        )}
        {phase === 'unavailable' && (
          <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
            <p>{t('clouddrive.request.unavailable')}</p>
            <Button variant="secondary" onClick={() => {
              setPhase('loading')
              void load().then((value) => {
                setInfo(value)
                setPhase(value.hasPassword ? 'locked' : 'ready')
              }).catch(() => setPhase('unavailable'))
            }}>{t('clouddrive.retry')}</Button>
          </div>
        )}
        {phase === 'locked' && (
          <form onSubmit={unlock} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <LockKeyhole size={16} className="text-[var(--text-tertiary)]" aria-hidden />
              <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.request.title')}</h1>
            </div>
            <Input
              type="password"
              autoComplete={NON_CREDENTIAL_AUTOCOMPLETE}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-label={t('clouddrive.share.password_label')}
              placeholder={t('clouddrive.share.password_label')}
              autoFocus
            />
            {error && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
            <Button type="submit" variant="primary" loading={submitting}>{t('clouddrive.share.unlock')}</Button>
          </form>
        )}
        {phase === 'ready' && info && (
          <div className="flex flex-col gap-3">
            <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.request.title')}</h1>
            <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{info.name}</p>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('clouddrive.request.limits', { files: remainingFiles, bytes: formatBytes(remainingBytes), fileBytes: formatBytes(info.maxFileBytes) })}
            </p>
            <input ref={fileInput} type="file" multiple hidden onChange={() => setError('')} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={<Upload size={13} />} disabled={uploading || remainingFiles === 0} onClick={() => fileInput.current?.click()}>
                {t('clouddrive.request.choose')}
              </Button>
              <Button variant="primary" loading={uploading} disabled={remainingFiles === 0} onClick={() => void upload()}>
                {t('clouddrive.request.upload')}
              </Button>
            </div>
            {error && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
            {done.length > 0 && (
              <div>
                <p className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">{t('clouddrive.request.uploaded')}</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {done.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
