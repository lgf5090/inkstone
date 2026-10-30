import { useEffect, useRef, useState, type FormEvent } from 'react'
import { HardDrive, LockKeyhole, Upload } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Input } from '../../../components/form'
import { Button, Spinner } from '../../../components/primitives'

interface RequestInfo {
  name: string
  hasPassword: boolean
  expiresAt: number | null
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
  receivedFiles: number
  receivedBytes: number
}

type Phase = 'loading' | 'ready' | 'locked' | 'unavailable'

export function DriveRequestPage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [info, setInfo] = useState<RequestInfo | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    const response = await fetch(`/api/public/clouddrive/requests/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
    if (!response.ok) {
      setPhase('unavailable')
      return
    }
    const value = await response.json() as RequestInfo
    setInfo(value)
    setPhase(value.hasPassword ? 'locked' : 'ready')
  }

  useEffect(() => {
    let cancelled = false
    fetch(`/api/public/clouddrive/requests/${encodeURIComponent(slug)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return await response.json() as RequestInfo
      })
      .then((value) => {
        if (cancelled) return
        setInfo(value)
        setPhase(value.hasPassword ? 'locked' : 'ready')
      })
      .catch(() => { if (!cancelled) setPhase('unavailable') })
    return () => { cancelled = true }
  }, [slug])

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch(`/api/public/clouddrive/requests/${encodeURIComponent(slug)}/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Inkstone-Client': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (response.status === 401) {
        setError(t('clouddrive.request.locked'))
        return
      }
      if (!response.ok) {
        setPhase('unavailable')
        return
      }
      setPhase('ready')
    } catch {
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
        const response = await fetch(
          `/api/public/clouddrive/requests/${encodeURIComponent(slug)}/upload?name=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'X-Inkstone-Client': '1',
              'Content-Type': file.type || 'application/octet-stream',
              ...(password ? { 'X-CloudDrive-Request-Password': password } : {}),
            },
            body: file,
          },
        )
        if (response.status === 401) {
          setPhase('locked')
          setError(t('clouddrive.request.locked'))
          break
        }
        const payload = await response.json().catch(() => null) as { name?: string; error?: { message?: string } } | null
        if (!response.ok) {
          setError(payload?.error?.message ?? t('clouddrive.request.upload_failed'))
          continue
        }
        saved.push(payload?.name ?? file.name)
      }
      if (saved.length > 0) {
        setDone((current) => [...saved, ...current].slice(0, 20))
        await load()
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
        {phase === 'loading' && <div className="flex items-center justify-center py-12"><Spinner /></div>}
        {phase === 'unavailable' && (
          <p role="status" className="py-8 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('clouddrive.request.unavailable')}</p>
        )}
        {phase === 'locked' && (
          <form onSubmit={unlock} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <LockKeyhole size={16} className="text-[var(--text-tertiary)]" aria-hidden />
              <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.request.title')}</h1>
            </div>
            <Input
              type="password"
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
