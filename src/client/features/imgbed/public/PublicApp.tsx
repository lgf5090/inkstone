import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Download, FileText, Folder, Maximize2, RotateCw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { usePathname } from '../../../lib/app-history'

interface PublicFile {
  name: string
  metadata: { FileType?: string; TimeStamp?: number; UpdatedAt?: number; FileSize?: string; Width?: number; Height?: number }
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

function ImagePreview({ url, alt, onPrev, onNext }: { url: string; alt: string; onPrev: () => void; onNext: () => void }): ReactElement {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const clamp = (value: number): number => Math.min(5, Math.max(0.5, value))
  const reset = (): void => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }) }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') onPrev()
      if (event.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, onNext])
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state) return
    setPan({ x: state.panX + event.clientX - state.startX, y: state.panY + event.clientY - state.startY })
  }
  const endDrag = (): void => { drag.current = null }
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setZoom((current) => clamp(current * (event.deltaY < 0 ? 1.15 : 0.87)))
  }
  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const point = event.touches[0]
    if (point) touch.current = { x: point.clientX, y: point.clientY }
  }
  const onTouchEnd = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const start = touch.current
    touch.current = null
    const point = event.changedTouches[0]
    if (!start || !point || zoom !== 1) return
    const dx = point.clientX - start.x
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(point.clientY - start.y)) return
    if (dx > 0) onPrev()
    else onNext()
  }
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex max-h-[64vh] min-h-[240px] cursor-grab touch-pan-y items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-inset)] active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onDoubleClick={reset}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <img
          src={url}
          alt={alt}
          draggable={false}
          className="max-h-[64vh] max-w-full select-none object-contain"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1">
        <IconButton label={t('imgbed.public.prev')} onClick={onPrev}><ChevronLeft size={14} /></IconButton>
        <IconButton label={t('imgbed.public.zoom_out')} onClick={() => setZoom((value) => clamp(value / 1.2))}><ZoomOut size={14} /></IconButton>
        <span className="min-w-12 text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">{Math.round(zoom * 100)}%</span>
        <IconButton label={t('imgbed.public.zoom_in')} onClick={() => setZoom((value) => clamp(value * 1.2))}><ZoomIn size={14} /></IconButton>
        <IconButton label={t('imgbed.public.rotate')} onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={14} /></IconButton>
        <IconButton label={t('imgbed.public.reset')} onClick={reset}><Maximize2 size={14} /></IconButton>
        <IconButton label={t('imgbed.public.next')} onClick={onNext}><ChevronRight size={14} /></IconButton>
      </div>
    </div>
  )
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
  const stepPreview = useCallback((delta: number): void => {
    setPreview((current) => {
      const files = data?.files ?? []
      if (!current || !files.length) return current
      const index = files.findIndex((file) => file.name === current.name)
      if (index < 0) return current
      return files[(index + delta + files.length) % files.length] ?? current
    })
  }, [data])

  const load = useCallback(async (reset: boolean) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ dir, start: String(reset ? 0 : start), count: '60' })
      if (search) params.set('search', search)
      if (type) params.set('type', type)
      const response = await fetch(`/api/imgbed/public/list?${params.toString()}`, { credentials: 'same-origin' })
      const body = await response.json().catch(() => null) as PublicList & { error?: string }
      if (!response.ok) {
        const known = body?.error === 'Directory not allowed'
          ? t('imgbed.public.directory_denied' as never)
          : body?.error
        throw new Error(known ?? t('imgbed.common.error'))
      }
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
              const url = `/imgbed/file/${filePath(file.name)}?v=${file.metadata.UpdatedAt ?? file.metadata.TimeStamp ?? 0}`
              return (
                <button key={file.name} type="button" onClick={() => setPreview(file)} className="mb-2 block w-full break-inside-avoid overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-left">
                  {fileType.startsWith('image/') && fileType !== 'image/svg+xml'
                    ? <img src={`${url}&width=480&height=360&fit=cover&fallback=original`} alt={file.name} loading="lazy" decoding="async" className="w-full" />
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
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name.split('/').pop() ?? ''} width={900} footer={preview ? <div className="flex justify-end gap-2"><Button icon={<Copy size={13} />} onClick={() => void copyText(`${location.origin}/imgbed/file/${filePath(preview.name)}?v=${preview.metadata.UpdatedAt ?? preview.metadata.TimeStamp ?? 0}`)}>{t('imgbed.upload.copy')}</Button><a href={`/imgbed/file/${filePath(preview.name)}?v=${preview.metadata.UpdatedAt ?? preview.metadata.TimeStamp ?? 0}&download=1`} className="inline-flex items-center gap-1 text-[length:var(--text-12)] text-[var(--accent)]"><Download size={13} />{t('imgbed.library.download')}</a></div> : null}>
        {preview && (() => {
          const fileType = preview.metadata.FileType ?? ''
          const url = `/imgbed/file/${filePath(preview.name)}?v=${preview.metadata.UpdatedAt ?? preview.metadata.TimeStamp ?? 0}`
          if (fileType.startsWith('video/')) return <video src={url} controls autoPlay className="max-h-[70vh] w-full" />
          if (fileType.startsWith('audio/')) return <audio src={url} controls autoPlay className="w-full" />
          if (fileType.startsWith('image/')) return <ImagePreview url={url} alt={preview.name} onPrev={() => stepPreview(-1)} onNext={() => stepPreview(1)} />
          return <div className="p-8 text-center text-[var(--text-tertiary)]">{t('imgbed.public.other')}</div>
        })()}
      </Modal>
    </div>
  )
}
