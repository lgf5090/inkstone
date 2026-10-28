import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react'
import { Clipboard, Copy, FolderOpen, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { Checkbox, Input, Select } from '../../../components/form'
import { Empty } from '../../../components/feedback'
import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { imgbedApi, imgbedExternalUpload, imgbedFetchUrl, imgbedUpload, type ImgbedConfigResponse } from '../api'
import { optimizeImageFile } from '../../../lib/image'

interface UploadItem {
  key: string
  name: string
  file: File
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  progress: number
  url?: string
  error?: string
}

const HISTORY_KEY = 'imgbed.upload_history'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function toWebp(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || /\.gif$/i.test(file.name)) return file
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' })
  } catch {
    return file
  }
}

export function UploadPage({ owner: _owner }: { owner: boolean }): ReactElement {
  const [config, setConfig] = useState<ImgbedConfigResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [items, setItems] = useState<UploadItem[]>([])
  const [folder, setFolder] = useState('')
  const [channel, setChannel] = useState('telegram')
  const [channelName, setChannelName] = useState('')
  const [nameType, setNameType] = useState('default')
  const [compress, setCompress] = useState(true)
  const [webp, setWebp] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [copyFormat, setCopyFormat] = useState('url')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<{ name: string; url: string; time: number }[]>([])
  const [announcementOpen, setAnnouncementOpen] = useState(false)
  const [externalOnly, setExternalOnly] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    imgbedApi<ImgbedConfigResponse>('/api/imgbed/config')
      .then((next) => {
        setConfig(next)
        setFolder(next.page.defaultFolder)
        const availableTypes = new Set(next.channels.map((item) => item.type))
        setChannel(availableTypes.has(next.page.defaultUploadChannel) ? next.page.defaultUploadChannel : ([...availableTypes][0] ?? next.page.defaultUploadChannel))
        setChannelName(next.page.defaultChannelName)
        setNameType(next.page.defaultNameType)
        setCompress(next.page.defaultCompress)
        setWebp(next.page.defaultConvertToWebp)
        if (next.page.announcement) {
          const acknowledged = Number(localStorage.getItem('imgbed.announcementAck') ?? 0)
          if (!acknowledged || (next.page.announcementRefreshAt ?? 0) > acknowledged) setAnnouncementOpen(true)
        }
      })
      .catch((error: Error) => setLoadError(error.message))
  }, [])

  const channelTypes = useMemo(() => {
    const types = new Set((config?.channels ?? []).map((item) => item.type))
    return [...types]
  }, [config])

  const channelNames = useMemo(
    () => (config?.channels ?? []).filter((item) => item.type === channel).map((item) => item.name),
    [config, channel],
  )

  const addFiles = (files: File[]): void => {
    if (!files.length) return
    setItems((current) => [
      ...current,
      ...files.map((file) => ({
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        file,
        status: 'waiting' as const,
        progress: 0,
      })),
    ])
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    addFiles(Array.from(event.dataTransfer.files ?? []))
  }

  const start = async (): Promise<void> => {
    if (!items.length || busy) return
    setBusy(true)
    for (const item of items.filter((entry) => entry.status === 'waiting' || entry.status === 'failed')) {
      setItems((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'uploading', progress: 0, error: undefined } : entry))
      try {
        let file = item.file
        if (compress && file.type.startsWith('image/') && file.size > 1024 * 1024) file = await optimizeImageFile(file)
        if (webp) file = await toWebp(file)
        const uploadFolder = folder.replace(/^\/+/, '')
        const result = await imgbedUpload(file, uploadFolder, nameType, channel, channelName, (percent) => {
          setItems((current) => current.map((entry) => entry.key === item.key ? { ...entry, progress: percent } : entry))
        })
        const first = result[0]
        setItems((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'done', progress: 100, url: first?.url } : entry))
        if (first?.url) {
          try {
            const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as { name: string; url: string; time: number }[]
            history.unshift({ name: item.name, url: first.url, time: Date.now() })
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 500)))
          } catch {  }
        }
      } catch (error) {
        setItems((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: 'failed', error: error instanceof Error ? error.message : t('imgbed.upload.failed') } : entry))
      }
    }
    setBusy(false)
  }

  const fetchUrl = async (): Promise<void> => {
    if (!urlInput.trim()) return
    try {
      if (externalOnly) {
        const result = await imgbedExternalUpload(urlInput.trim(), folder.replace(/^\/+/, ''), nameType)
        const first = result[0]
        setItems((current) => [...current, { key: `ext-${Date.now()}`, name: new URL(urlInput.trim()).pathname.split('/').pop() || 'external', file: new File([], 'external'), status: 'done', progress: 100, url: first?.url }])
      } else {
        const fetched = await imgbedFetchUrl(urlInput.trim())
        addFiles([new File([fetched.blob], fetched.fileName, { type: fetched.blob.type || 'application/octet-stream' })])
      }
      setUrlInput('')
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const formatLink = (url: string, name: string): string => {
    const absolute = url.startsWith('http') ? url : `${location.origin}${url}`
    if (copyFormat === 'md') return `![${name}](${absolute})`
    if (copyFormat === 'html') return `<img src="${absolute}" alt="${name}" width=100% />`
    if (copyFormat === 'bb') return `[img]${absolute}[/img]`
    return absolute
  }

  const copy = async (url: string, name: string): Promise<void> => {
    if (await copyText(formatLink(url, name))) toast({ title: t('imgbed.upload.copied'), tone: 'success' })
  }

  const openHistory = (): void => {
    try { setHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as { name: string; url: string; time: number }[]) } catch { setHistory([]) }
    setHistoryOpen(true)
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-3 md:p-5">
      <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('imgbed.upload.title')}</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('imgbed.upload.folder')}
          <Input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={t('imgbed.upload.folder_placeholder' as never)} />
        </label>
        <label className="flex w-[150px] flex-col gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('imgbed.upload.channel')}
          <Select value={channel} onChange={(event) => { setChannel(event.target.value); setChannelName('') }}>
            {channelTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </Select>
        </label>
        <label className="flex w-[150px] flex-col gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('imgbed.upload.channel_name')}
          <Select value={channelName} onChange={(event) => setChannelName(event.target.value)}>
            <option value="">{t('imgbed.public.all')}</option>
            {channelNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </label>
        <label className="flex w-[140px] flex-col gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('imgbed.upload.name_type')}
          <Select value={nameType} onChange={(event) => setNameType(event.target.value)}>
            <option value="default">{t('imgbed.name.default' as never)}</option>
            <option value="index">{t('imgbed.name.index' as never)}</option>
            <option value="origin">{t('imgbed.name.origin' as never)}</option>
            <option value="short">{t('imgbed.name.short' as never)}</option>
          </Select>
        </label>
        <label className="flex w-[120px] flex-col gap-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('imgbed.upload.link_format' as never)}
          <Select value={copyFormat} onChange={(event) => setCopyFormat(event.target.value)}>
            <option value="url">{t('imgbed.format.url')}</option><option value="md">{t('imgbed.format.markdown')}</option><option value="html">{t('imgbed.format.html')}</option><option value="bb">{t('imgbed.format.bbcode')}</option>
          </Select>
        </label>
        <Button variant="secondary" onClick={openHistory}>{t('imgbed.upload.history' as never)}</Button>
      </div>

      {loadError && <div role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)] p-3 text-[length:var(--text-12)] text-[var(--danger)]">{loadError}</div>}

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border-2 border-dashed border-[var(--border-default)] bg-[var(--bg-surface)] p-5 text-center"
      >
        <ImagePlus size={28} className="text-[var(--text-quaternary)]" />
        <p className="max-w-[420px] text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">{t('imgbed.upload.hint')}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>{t('imgbed.upload.choose')}</Button>
          <Button variant="secondary" icon={<FolderOpen size={14} />} onClick={() => folderRef.current?.click()}>{t('imgbed.upload.folder')}</Button>
          <Button variant="primary" disabled={!items.length || busy} loading={busy} onClick={() => void start()}>{t('imgbed.upload.start')}</Button>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={onFileChange} />
        <input ref={folderRef} type="file" multiple hidden onChange={onFileChange} {...({ webkitdirectory: 'true' } as Record<string, string>)} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={compress} onChange={setCompress} label={t('imgbed.upload.compress')} />
        <Checkbox checked={webp} onChange={setWebp} label={t('imgbed.upload.webp')} />
        <Checkbox checked={externalOnly} onChange={setExternalOnly} label={t('imgbed.upload.external' as never)} />
        <div className="flex min-w-[240px] flex-1 items-center gap-1">
          <Input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder={t('imgbed.upload.paste_url')} />
          <Button variant="secondary" icon={<Clipboard size={14} />} onClick={() => void fetchUrl()}>{t('imgbed.upload.fetch')}</Button>
        </div>
      </div>

      {items.some((item) => item.url) && <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => { const links = items.filter((item) => item.url).map((item) => formatLink(item.url!, item.name)).join('\n'); void copyText(links).then((ok) => toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' })) }}>{t('imgbed.upload.copy_all' as never)}</Button></div>}
      {items.length === 0 ? (
        <Empty art="search" title={t('imgbed.upload.empty')} compact />
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{item.name}</div>
                <div className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{formatSize(item.file.size)} · {item.status}</div>
                {item.status === 'uploading' && <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--bg-inset)]"><div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${item.progress}%` }} /></div>}
                {item.error && <div className="text-[length:var(--text-11)] text-[var(--danger)]">{item.error}</div>}
              </div>
              {item.status === 'uploading' && <Loader2 size={14} className="animate-spin text-[var(--text-tertiary)]" />}
              {item.url && <IconButton label={t('imgbed.upload.copy')} onClick={() => void copy(item.url!, item.name)}><Copy size={14} /></IconButton>}
              <IconButton label={t('imgbed.common.close')} onClick={() => setItems((current) => current.filter((entry) => entry.key !== item.key))}><Trash2 size={14} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title={t('imgbed.upload.history' as never)} width={560} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }}>{t('imgbed.upload.clear_history' as never)}</Button><Button onClick={() => setHistoryOpen(false)}>{t('imgbed.common.close')}</Button></div>}>
        {history.length === 0 ? <Empty art="search" title={t('imgbed.upload.no_history' as never)} compact /> : <ul className="max-h-[50vh] divide-y divide-[var(--border-subtle)] overflow-auto">{history.map((entry, index) => <li key={`${entry.time}-${index}`} className="flex items-center gap-2 py-2"><span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)]">{entry.name}</span><IconButton label={t('imgbed.upload.copy')} onClick={() => void copy(entry.url, entry.name)}><Copy size={13} /></IconButton></li>)}</ul>}
      </Modal>
      <Modal open={announcementOpen} onClose={() => { setAnnouncementOpen(false); localStorage.setItem('imgbed.announcementAck', String(Date.now())) }} title={t('imgbed.upload.announcement' as never)} width={560} footer={<div className="flex justify-end"><Button onClick={() => { setAnnouncementOpen(false); localStorage.setItem('imgbed.announcementAck', String(Date.now())) }}>{t('imgbed.upload.announcement_ack' as never)}</Button></div>}><p className="whitespace-pre-wrap text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">{config?.page.announcement}</p></Modal>
    </div>
  )
}
