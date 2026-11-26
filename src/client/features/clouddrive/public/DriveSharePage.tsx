import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { FileArchive, HardDrive, LockKeyhole, Save } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Input } from '../../../components/form'
import { Button, Spinner } from '../../../components/primitives'
import { NON_CREDENTIAL_AUTOCOMPLETE } from '../../../lib/autocomplete'
import { CloudDriveApiError } from '../api'
import { useSession } from '../../../store/session'
import { cloudDrivePublicApi, type PublicShareEntry, type PublicShareMeta } from './api'

type Phase = 'loading' | 'ready' | 'locked' | 'unavailable' | 'expired'
type FolderStatus = 'loading' | 'ready' | 'error'

/** The types the share route is willing to draw in place; it adds PDF to the app-wide inline list. */
function isRenderable(mime: string): boolean {
  return (mime.startsWith('image/') && mime !== 'image/svg+xml')
    || mime.startsWith('audio/')
    || mime.startsWith('video/')
    || mime === 'application/pdf'
}

export function DriveSharePage({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [meta, setMeta] = useState<PublicShareMeta | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [entries, setEntries] = useState<PublicShareEntry[]>([])
  const [sharePath, setSharePath] = useState('/')
  const [folderStatus, setFolderStatus] = useState<FolderStatus>('loading')
  const [folderReloadKey, setFolderReloadKey] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const signedIn = useSession((state) => Boolean(state.user))

  const load = useCallback(() => cloudDrivePublicApi.share(slug), [slug])

  const applyMeta = useCallback((value: PublicShareMeta) => {
    setMeta(value)
    setSharePath('/')
    setPhase(value.disabled ? 'unavailable' : value.locked ? 'locked' : 'ready')
  }, [])

  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setMeta(null)
    setError('')
    void load()
      .then((value) => { if (!cancelled) applyMeta(value) })
      .catch(() => { if (!cancelled) setPhase('unavailable') })
    return () => { cancelled = true }
  }, [applyMeta, load])

  const unlock = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await cloudDrivePublicApi.verifyShare(slug, password)
      // The name, size and type only come back once the link is unlocked, so the metadata has to be
      // re-read rather than assumed.
      const value = await load()
      applyMeta(value)
    } catch (caught) {
      if (caught instanceof CloudDriveApiError && caught.status === 401) {
        setError(t('clouddrive.error.share_locked'))
        return
      }
      if (caught instanceof CloudDriveApiError && caught.status === 429) {
        setError(t('clouddrive.error.too_many_attempts'))
        return
      }
      if (caught instanceof CloudDriveApiError && caught.status === 404) {
        setPhase('expired')
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

  const contentUrl = (path: string, download: boolean) => cloudDrivePublicApi.shareContentUrl(slug, path, download)

  const saveToDrive = async () => {
    setSaving(true)
    setSaveError('')
    try {
      const saved = await cloudDrivePublicApi.saveShare(slug, '/')
      setSaveError(t('clouddrive.share.saved', { value0: saved.entry.name }))
    } catch (caught) {
      setSaveError(caught instanceof CloudDriveApiError && caught.status === 401
        ? t('clouddrive.share.sign_in_to_save')
        : t('clouddrive.share.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const fetchFolder = useCallback(
    (at: string | null) => cloudDrivePublicApi.listShare(slug, sharePath, at),
    [sharePath, slug],
  )

  useEffect(() => {
    if (phase !== 'ready' || meta?.targetKind !== 'folder') return
    let cancelled = false
    setPreviewPath(null)
    setPicked(new Set())
    setEntries([])
    setCursor(null)
    setTotal(null)
    setLoadMoreError(false)
    setFolderStatus('loading')
    void fetchFolder(null)
      .then((value) => {
        if (cancelled) return
        setEntries(value.entries)
        setCursor(value.cursor)
        setTotal(value.total)
        setFolderStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setFolderStatus('error')
      })
    return () => { cancelled = true }
  }, [phase, meta?.targetKind, fetchFolder, folderReloadKey])

  const loadMore = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(false)
    try {
      const value = await fetchFolder(cursor)
      setEntries((current) => [...current, ...value.entries])
      setCursor(value.cursor)
      setTotal(value.total)
    } catch {
      setLoadMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  /**
   * Downloads the picked files one after another. A browser only ever runs one navigation per
   * gesture, so the links are clicked in sequence with a short gap rather than all at once.
   */
  const downloadPicked = async () => {
    const targets = entries.filter((entry) => picked.has(entry.path) && entry.kind === 'file')
    for (const [index, entry] of targets.entries()) {
      await new Promise((resolve) => window.setTimeout(resolve, index * 400))
      const link = document.createElement('a')
      link.href = contentUrl(entry.path, true)
      link.download = entry.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    }
  }

  const goUp = () => {
    const cut = sharePath.lastIndexOf('/')
    setSharePath(cut <= 0 ? '/' : sharePath.slice(0, cut))
  }

  const preview = meta && meta.targetKind === 'file' && isRenderable(meta.mime ?? '')
    ? { url: contentUrl('/', false), mime: meta.mime ?? '' }
    : null

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
            <p>{t('clouddrive.share.unavailable')}</p>
            <Button variant="secondary" onClick={() => {
              setPhase('loading')
              void load().then(applyMeta).catch(() => setPhase('unavailable'))
            }}>{t('clouddrive.retry')}</Button>
          </div>
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
              autoComplete={NON_CREDENTIAL_AUTOCOMPLETE}
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
                {meta.targetKind === 'folder'
                  ? t('clouddrive.share.folder')
                  : [meta.mime, meta.size ? formatBytes(meta.size) : ''].filter(Boolean).join(' · ')}
              </p>
            </div>
            {preview && (
              <SharePreview url={preview.url} mime={preview.mime} name={meta.name} />
            )}
            {meta.targetKind === 'file' && meta.allowDownload && (
              <a
                className="inline-flex h-9 items-center justify-center gap-1.5 self-start rounded-[var(--r-md)] bg-[var(--accent)] px-4 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)]"
                href={contentUrl('/', true)}
              >
                {t('clouddrive.share.download')}
              </a>
            )}
            {meta.targetKind === 'file' && !meta.allowDownload && !preview && (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.no_download')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {signedIn && meta.allowDownload && (
                <Button size="sm" variant="secondary" icon={<Save size={13} />} loading={saving} onClick={() => void saveToDrive()}>
                  {t('clouddrive.share.save_to_drive')}
                </Button>
              )}
              {meta.targetKind === 'folder' && meta.allowDownload && (
                <a
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--r-md)] bg-[var(--accent)] px-4 text-[length:var(--text-12)] font-medium text-[var(--accent-contrast)]"
                  href={cloudDrivePublicApi.shareZipUrl(slug)}
                >
                  <FileArchive size={14} aria-hidden />{t('clouddrive.share.download_zip')}
                </a>
              )}
            </div>
            {saveError && <p role="status" className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{saveError}</p>}
            {meta.targetKind === 'folder' && (
              <div className="flex flex-col gap-1">
                {sharePath !== '/' && <button type="button" className="self-start text-[length:var(--text-11)] text-[var(--accent)]" onClick={goUp}>{t('clouddrive.toolbar.back')}</button>}
                {folderStatus === 'loading' && (
                  <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-6 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    <Spinner /><span>{t('clouddrive.loading')}</span>
                  </div>
                )}
                {folderStatus === 'error' && (
                  <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    <p>{t('clouddrive.share.folder_load_failed')}</p>
                    <Button variant="secondary" onClick={() => setFolderReloadKey((key) => key + 1)}>{t('clouddrive.retry')}</Button>
                  </div>
                )}
                {folderStatus === 'ready' && total !== null && (
                  <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.share.folder_total', { count: total })}</p>
                )}
                {folderStatus === 'ready' && entries.length === 0 && <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.share.folder_empty')}</p>}
                {folderStatus === 'ready' && entries.map((entry) => (
                  <div key={entry.path} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5">
                    {entry.kind === 'file' && meta.allowDownload && (
                      <input
                        type="checkbox"
                        className="cd-checkbox shrink-0"
                        checked={picked.has(entry.path)}
                        aria-label={t('clouddrive.share.pick', { value0: entry.name })}
                        onChange={(event) => setPicked((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(entry.path)
                          else next.delete(entry.path)
                          return next
                        })}
                      />
                    )}
                    {entry.kind === 'folder'
                      ? <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]" onClick={() => setSharePath(entry.path)}>{entry.name}</button>
                      : meta.allowDownload || isRenderable(entry.mime)
                        ? (
                          <a
                            className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]"
                            href={meta.allowDownload ? contentUrl(entry.path, true) : contentUrl(entry.path, false)}
                            {...(meta.allowDownload ? { download: '' } : {})}
                          >
                            {entry.name}
                          </a>
                        )
                        : (
                          <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{entry.name}</span>
                        )}
                    {entry.kind === 'file' && isRenderable(entry.mime) && (
                      <button
                        type="button"
                        className="shrink-0 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--accent)] hover:bg-[var(--bg-hover)]"
                        aria-pressed={previewPath === entry.path}
                        onClick={() => setPreviewPath(previewPath === entry.path ? null : entry.path)}
                      >
                        {t('clouddrive.share.preview')}
                      </button>
                    )}
                    {entry.kind === 'file' && <span className="shrink-0 text-[length:var(--text-10)] tabular-nums text-[var(--text-tertiary)]">{formatBytes(entry.size)}</span>}
                    <span className="hidden shrink-0 text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)] sm:inline">{new Date(entry.modifiedAt).toLocaleString()}</span>
                  </div>
                ))}
                {loadMoreError && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{t('clouddrive.share.folder_load_failed')}</p>}
                {cursor && (
                  <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore()} className="self-start">
                    {t(loadMoreError ? 'clouddrive.retry' : 'clouddrive.search.load_more')}
                  </Button>
                )}
                {picked.size > 0 && meta.allowDownload && (
                  <Button size="sm" variant="primary" onClick={() => void downloadPicked()} className="self-start">
                    {t('clouddrive.share.download_picked', { count: picked.size })}
                  </Button>
                )}
                {previewPath && (() => {
                  const entry = entries.find((one) => one.path === previewPath)
                  return entry ? (
                    <div className="mt-2 flex flex-col gap-1">
                      <p className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{entry.name}</p>
                      <SharePreview url={contentUrl(entry.path, false)} mime={entry.mime} name={entry.name} />
                    </div>
                  ) : null
                })()}
                {!meta.allowDownload && (
                  <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('clouddrive.share.no_download')}</p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}

function SharePreview({ url, mime, name }: { url: string; mime: string; name: string }) {
  if (mime === 'application/pdf') {
    // The browser's own viewer, framed from this origin: the CSP already allows `frame-src 'self'`.
    return <iframe src={url} title={name} className="h-[60vh] w-full rounded-[var(--r-md)] border border-[var(--border-subtle)]" />
  }
  if (mime.startsWith('video/')) {
    return <video src={url} controls className="max-h-[60vh] w-full rounded-[var(--r-md)] bg-black" aria-label={name} />
  }
  if (mime.startsWith('audio/')) {
    return <audio src={url} controls className="w-full" aria-label={name} />
  }
  return <img src={url} alt={name} className="max-h-[60vh] w-full rounded-[var(--r-md)] object-contain" />
}
