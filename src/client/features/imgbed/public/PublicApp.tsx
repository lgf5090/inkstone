import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, Copy, Download, FileText, Folder, Search } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { usePathname } from '../../../lib/app-history'

interface PublicFile {
  name: string
  metadata: { FileType?: string; TimeStamp?: number; FileSize?: string; Width?: number; Height?: number }
}

interface PublicList {
  files: PublicFile[]
  directories: string[]
  totalCount: number
  allowedDirs: string[]
}

function directoryOf(pathname: string): string {
  const raw = pathname.replace(/^\/imgbed\/browse\/?/, '').replace(/\/+$/, '')
  return raw ? `${raw}/` : ''
}

function filePath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

function formatSize(value?: string): string {
  return value ? `${value} MB` : ''
}

export function PublicApp(): ReactElement {
  const pathname = usePathname()
  const dir = useMemo(() => directoryOf(pathname), [pathname])
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [data, setData] = useState<PublicList | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<PublicFile | null>(null)
  const [start, setStart] = useState(0)

  const load = useCallback(async (reset: boolean) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ dir, start: String(reset ? 0 : start), count: '60' })
      if (search) params.set('search', search)
      if (type) params.set('type', type)
      const response = await fetch(`/api/imgbed/public/list?${params.toString()}`, { credentials: 'same-origin' })
      const body = await response.json().catch(() => null) as PublicList & { error?: string }
      if (!response.ok) throw new Error(body?.error ?? t('imgbed.common.error'))
      if (reset) {
        setData(body)
        setStart(body.files.length)
      } else {
        setData((current) => current ? { ...body, files: [...current.files, ...body.files] } : body)
        setStart((current) => current + body.files.length)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('imgbed.common.error'))
    } finally {
      setLoading(false)
    }
  }, [dir, search, type, start])

  useEffect(() => {
    fetch('/api/imgbed/public/config', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((body: { enabled: boolean }) => setEnabled(Boolean(body.enabled)))
      .catch(() => setEnabled(false))
  }, [])

  useEffect(() => { if (enabled) void load(true) }, [enabled, dir, search, type])

  const up = (): void => {
    const parts = dir.split('/').filter(Boolean)
    parts.pop()
    window.history.pushState({}, '', `/imgbed/browse/${parts.join('/')}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  if (enabled === null) return <div className="flex h-full items-center justify-center"><LoadingBlock label={t('imgbed.common.loading')} /></div>
  if (!enabled) return <div className="flex h-full items-center justify-center p-8"><Empty art="search" title={t('imgbed.public.disabled')} /></div>

  return (
    <div className="min-h-full bg-[var(--bg-base)] p-3 md:p-5">
      <header className="mx-auto mb-3 flex max-w-6xl flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('imgbed.public.title')}</h1>
        <div className="flex min-w-[200px] flex-1 items-center gap-1">
          <Input leading={<Search size={13} />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('imgbed.public.search')} />
          <Select value={type} onChange={(event) => setType(event.target.value)} className="w-[110px]">
            <option value="">{t('imgbed.public.all')}</option>
            <option value="image">{t('imgbed.public.images')}</option>
            <option value="video">{t('imgbed.public.videos')}</option>
            <option value="audio">{t('imgbed.public.audio')}</option>
            <option value="other">{t('imgbed.public.other')}</option>
          </Select>
        </div>
      </header>
      <div className="mx-auto max-w-6xl">
        {dir && <IconButton label={t('imgbed.library.folder_up')} onClick={up}><ArrowLeft size={15} /></IconButton>}
        <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">/{dir}</span>
      </div>
      {loading && !data ? <LoadingBlock label={t('imgbed.common.loading')} /> : error ? <Empty art="search" title={error} action={<Button onClick={() => void load(true)}>{t('imgbed.common.retry')}</Button>} /> : (
        <>
          <div className="mx-auto mt-3 max-w-6xl columns-2 gap-2 sm:columns-3 lg:columns-4">
            {data?.directories.map((directory) => (
              <a key={directory} href={`/imgbed/browse/${directory.replace(/\/$/, '')}`} className="mb-2 flex min-h-[90px] break-inside-avoid flex-col items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 text-center">
                <Folder size={22} className="text-[var(--accent)]" />
                <span className="mt-1 max-w-full truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{directory.split('/').filter(Boolean).pop()}</span>
              </a>
            ))}
            {data?.files.map((file) => {
              const fileType = file.metadata.FileType ?? ''
              const url = `/imgbed/file/${filePath(file.name)}`
              return (
                <button key={file.name} type="button" onClick={() => setPreview(file)} className="mb-2 block w-full break-inside-avoid overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-left">
                  {fileType.startsWith('image/') && fileType !== 'image/svg+xml'
                    ? <img src={url} alt={file.name} loading="lazy" decoding="async" className="w-full" />
                    : fileType.startsWith('video/')
                      ? <video src={url} className="w-full" muted playsInline preload="metadata" />
                      : <div className="flex min-h-[100px] items-center justify-center"><FileText size={24} className="text-[var(--text-quaternary)]" /></div>}
                  <div className="p-2 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]"><span className="block truncate">{file.name.split('/').pop()}</span>{formatSize(file.metadata.FileSize)}</div>
                </button>
              )
            })}
          </div>
          {!data?.files.length && !data?.directories.length && <Empty art="search" title={t('imgbed.public.empty')} />}
          {data && data.files.length > 0 && start < data.totalCount && <div className="flex justify-center p-3"><Button loading={loading} onClick={() => void load(false)}>{t('imgbed.common.loading')}</Button></div>}
        </>
      )}
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name.split('/').pop() ?? ''} width={900} footer={preview ? <div className="flex justify-end gap-2"><Button icon={<Copy size={13} />} onClick={() => void copyText(`${location.origin}/imgbed/file/${filePath(preview.name)}`)}>{t('imgbed.upload.copy')}</Button><a href={`/imgbed/file/${filePath(preview.name)}?download=1`} className="inline-flex items-center gap-1 text-[length:var(--text-12)] text-[var(--accent)]"><Download size={13} />{t('imgbed.library.download')}</a></div> : null}>
        {preview && (() => {
          const fileType = preview.metadata.FileType ?? ''
          const url = `/imgbed/file/${filePath(preview.name)}`
          if (fileType.startsWith('video/')) return <video src={url} controls autoPlay className="max-h-[70vh] w-full" />
          if (fileType.startsWith('audio/')) return <audio src={url} controls autoPlay className="w-full" />
          if (fileType.startsWith('image/')) return <img src={url} alt={preview.name} className="max-h-[70vh] w-full object-contain" />
          return <div className="p-8 text-center text-[var(--text-tertiary)]">{t('imgbed.public.other')}</div>
        })()}
      </Modal>
    </div>
  )
}
