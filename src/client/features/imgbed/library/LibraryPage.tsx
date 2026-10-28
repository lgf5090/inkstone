import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { downloadZip } from 'client-zip'
import { ArrowLeft, Copy, Download, FileText, Folder, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { ImgbedFile, ImgbedListResult } from '@shared/imgbed/model'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Modal, confirm, prompt } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { downloadBlob } from '../../../lib/export-note'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { imgbedApi, imgbedCopyLinks, imgbedDelete, imgbedList, imgbedMove, imgbedRename, imgbedSetAccess, imgbedSetTags } from '../api'

const PAGE_SIZE = 30

function filePath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function LibraryPage(): ReactElement {
  const [data, setData] = useState<ImgbedListResult | null>(null)
  const [dir, setDir] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('time')
  const [typeFilter, setTypeFilter] = useState('')
  const [accessFilter, setAccessFilter] = useState('')
  const [channelFilter, setChannelFilter] = useState('')
  const [start, setStart] = useState(0)
  const [channels, setChannels] = useState<{ type: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ImgbedFile | null>(null)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async (reset = true) => {
    setLoading(true)
    setError('')
    try {
      const offset = reset ? 0 : start
      const next = await imgbedList({
        dir, search, sort, count: PAGE_SIZE, start: offset, recursive: Boolean(search),
        fileType: typeFilter ? [typeFilter] : undefined,
        accessStatus: accessFilter ? [accessFilter] : undefined,
        channel: channelFilter ? [channelFilter] : undefined,
      })
      if (reset) {
        setData(next)
        setStart(next.files.length)
      } else {
        setData((current) => current ? { ...next, directories: current.directories, files: [...current.files, ...next.files] } : next)
        setStart(offset + next.files.length)
      }
      setSelected((current) => new Set([...current].filter((id) => next.files.some((file) => file.id === id) || !reset)))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('imgbed.common.error'))
    } finally {
      setLoading(false)
    }
  }, [dir, search, sort, typeFilter, accessFilter, channelFilter, start])

  useEffect(() => { void load(true) }, [dir, search, sort, typeFilter, accessFilter, channelFilter])
  useEffect(() => {
    imgbedApi<{ channels: { type: string; name: string }[] }>('/api/imgbed/channels').then((result) => setChannels(result.channels)).catch(() => {})
  }, [])

  const ids = [...selected]
  const allSelected = Boolean(data?.files.length) && data!.files.every((file) => selected.has(file.id))

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const deleteSelected = async (): Promise<void> => {
    if (!ids.length) return
    if (!(await confirm({ title: t('imgbed.library.confirm_delete'), tone: 'danger', confirmLabel: t('imgbed.library.delete') }))) return
    try {
      for (const id of ids) await imgbedDelete(id)
      setSelected(new Set())
      toast({ title: t('imgbed.library.deleted'), tone: 'success' })
      await load(true)
    } catch (deleteError) {
      toast({ title: deleteError instanceof Error ? deleteError.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const moveSelected = async (): Promise<void> => {
    if (!ids.length) return
    const dist = await prompt({ title: t('imgbed.library.move'), description: t('imgbed.library.move_prompt'), defaultValue: dir })
    if (dist === null) return
    try {
      await imgbedMove(ids, dist)
      setSelected(new Set())
      await load(true)
    } catch (moveError) {
      toast({ title: moveError instanceof Error ? moveError.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const tagSelected = async (): Promise<void> => {
    if (!ids.length) return
    const value = await prompt({ title: t('imgbed.library.tags'), description: t('imgbed.library.tags_prompt'), defaultValue: '' })
    if (value === null) return
    const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean)
    try {
      for (const id of ids) await imgbedSetTags(id, tags, 'add')
      toast({ title: t('imgbed.library.saved'), tone: 'success' })
    } catch (tagError) {
      toast({ title: tagError instanceof Error ? tagError.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const copySelected = async (): Promise<void> => {
    if (!ids.length) return
    try {
      const links = await imgbedCopyLinks(ids, 'originUrl')
      if (await copyText(links)) toast({ title: t('imgbed.upload.copied'), tone: 'success' })
    } catch (copyError) {
      toast({ title: copyError instanceof Error ? copyError.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const downloadSelected = async (): Promise<void> => {
    const files = (data?.files ?? []).filter((file) => selected.has(file.id))
    if (!files.length) return
    try {
      const entries = await Promise.all(files.map(async (file) => {
        const response = await fetch(`/imgbed/file/${filePath(file.id)}?from=admin`)
        if (!response.ok) throw new Error(t('imgbed.common.error'))
        return { name: file.fileName, lastModified: new Date(file.createdAt), input: response }
      }))
      downloadBlob(`imgbed-${Date.now()}.zip`, await downloadZip(entries).blob())
    } catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }

  const accessSelected = async (listType: string): Promise<void> => {
    if (!ids.length) return
    try {
      await imgbedSetAccess(ids, listType)
      toast({ title: t('imgbed.library.saved'), tone: 'success' })
      await load(true)
    } catch (accessError) {
      toast({ title: accessError instanceof Error ? accessError.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }

  const up = (): void => {
    const parts = dir.split('/').filter(Boolean)
    parts.pop()
    setDir(parts.length ? `${parts.join('/')}/` : '')
  }

  return (
    <div className="flex flex-col gap-3 p-3 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label={t('imgbed.library.folder_up')} onClick={up} disabled={!dir}><ArrowLeft size={15} /></IconButton>
        <div className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">/{dir}</div>
        <div className="flex min-w-[220px] items-center gap-1">
          <Input leading={<Search size={13} />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('imgbed.library.search')} />
        </div>
        <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="w-[110px]">
          <option value="">{t('imgbed.public.all')}</option>
          <option value="image">{t('imgbed.public.images')}</option>
          <option value="video">{t('imgbed.public.videos')}</option>
          <option value="audio">{t('imgbed.public.audio')}</option>
          <option value="other">{t('imgbed.public.other')}</option>
        </Select>
        <Select value={accessFilter} onChange={(event) => setAccessFilter(event.target.value)} className="w-[120px]">
          <option value="">{t('imgbed.library.access')}</option>
          <option value="normal">{t('imgbed.library.normal')}</option>
          <option value="blocked">{t('imgbed.library.blocked')}</option>
        </Select>
        <Select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)} className="w-[130px]">
          <option value="">{t('imgbed.library.channel')}</option>
          {[...new Set(channels.map((channel) => channel.type))].map((type) => <option key={type} value={type}>{type}</option>)}
        </Select>
        <Select value={sort} onChange={(event) => setSort(event.target.value)} className="w-[130px]">
          <option value="time">{t('imgbed.sort.time' as never)}</option>
          <option value="size">{t('imgbed.sort.size' as never)}</option>
          <option value="fileName">{t('imgbed.sort.file_name' as never)}</option>
        </Select>
        <IconButton label={t('imgbed.common.retry')} onClick={() => void load(true)}><RefreshCw size={15} /></IconButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Checkbox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(data?.files.map((file) => file.id) ?? []))} label={t('imgbed.library.select_all')} />
        {ids.length > 0 && <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('imgbed.library.selected', { count: ids.length })}</span>}
        {ids.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => void copySelected()}>{t('imgbed.library.copy_links')}</Button>
            <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => void downloadSelected()}>{t('imgbed.library.download')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void moveSelected()}>{t('imgbed.library.move')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void tagSelected()}>{t('imgbed.library.tags')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void accessSelected('White')}>{t('imgbed.library.white')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void accessSelected('Block')}>{t('imgbed.library.blocked')}</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void deleteSelected()}>{t('imgbed.library.delete')}</Button>
          </div>
        )}
      </div>

      {loading ? <LoadingBlock label={t('imgbed.common.loading')} /> : error ? (
        <Empty art="search" title={error} action={<Button onClick={() => void load()}>{t('imgbed.common.retry')}</Button>} />
      ) : !data?.files.length && !data?.directories.length ? (
        <Empty art="search" title={t('imgbed.library.empty')} />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {data.directories.map((directory) => (
            <button
              key={directory}
              type="button"
              onClick={() => setDir(directory)}
              className="flex min-h-[92px] flex-col items-center justify-center gap-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2 text-center hover:bg-[var(--bg-hover)]"
            >
              <Folder size={22} className="text-[var(--accent)]" />
              <span className="w-full truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{directory.split('/').filter(Boolean).pop()}</span>
            </button>
          ))}
          {data.files.map((file) => {
            const image = file.fileType.startsWith('image/') && file.fileType !== 'image/svg+xml'
            return (
              <div key={file.id} className="group relative overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                <div className="absolute left-1.5 top-1.5 z-10 rounded bg-[var(--bg-overlay)]/80 p-0.5">
                  <Checkbox checked={selected.has(file.id)} onChange={() => toggle(file.id)} ariaLabel={file.id} />
                </div>
                <button type="button" onClick={() => setDetail(file)} className="block w-full text-left">
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-inset)]">
                    {image
                      ? <img src={`/imgbed/file/${filePath(file.id)}?from=admin`} alt={file.fileName} loading="lazy" decoding="async" className="size-full object-cover" />
                      : <FileText size={26} className="text-[var(--text-quaternary)]" />}
                  </div>
                  <div className="px-2 py-1.5">
                    <div className="truncate text-[length:var(--text-11-5)] text-[var(--text-primary)]">{file.fileName}</div>
                    <div className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatBytes(file.sizeBytes)} · {file.channelName}</div>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      )}

      <FileDetail file={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); void load() }} />
    </div>
  )
}

function FileDetail({ file, onClose, onChanged }: { file: ImgbedFile | null; onClose: () => void; onChanged: () => void }): ReactElement {
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiTags, setAiTags] = useState<string[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  useEffect(() => {
    if (!file) return
    imgbedApi<{ enabled: boolean }>('/api/imgbed/ai/tags').then((result) => setAiEnabled(result.enabled)).catch(() => setAiEnabled(false))
  }, [file?.id])
  if (!file) return <Modal open={false} onClose={onClose} title="">{null}</Modal>
  const url = `/imgbed/file/${filePath(file.id)}`
  const image = file.fileType.startsWith('image/') && file.fileType !== 'image/svg+xml'
  const rename = async (): Promise<void> => {
    const next = await prompt({ title: t('imgbed.library.rename'), description: t('imgbed.library.rename_prompt'), defaultValue: file.id })
    if (!next) return
    setBusy(true)
    try { await imgbedRename(file.id, next); toast({ title: t('imgbed.library.saved'), tone: 'success' }); onChanged() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setBusy(false) }
  }
  const tags = async (): Promise<void> => {
    const value = await prompt({ title: t('imgbed.library.tags'), description: t('imgbed.library.tags_prompt'), defaultValue: file.tags.join(', ') })
    if (value === null) return
    setBusy(true)
    try { await imgbedSetTags(file.id, value.split(',').map((tag) => tag.trim()).filter(Boolean), 'set'); toast({ title: t('imgbed.library.saved'), tone: 'success' }); onChanged() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setBusy(false) }
  }
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('imgbed.library.confirm_delete'), tone: 'danger', confirmLabel: t('imgbed.library.delete') }))) return
    setBusy(true)
    try { await imgbedDelete(file.id); onChanged() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setBusy(false) }
  }
  const generateAi = async (): Promise<void> => {
    setAiBusy(true)
    setAiTags(null)
    try {
      const response = await fetch(`${url}?from=admin`)
      if (!response.ok) throw new Error(t('imgbed.common.error'))
      const bitmap = await createImageBitmap(await response.blob())
      const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (blob && blob.size > 256 * 1024) blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.55))
      if (!blob) throw new Error(t('imgbed.common.error'))
      const form = new FormData()
      form.append('items', JSON.stringify([{ fileId: file.id }]))
      form.append('image0', new File([blob], 'preview.jpg', { type: 'image/jpeg' }))
      const result = await imgbedApi<{ results: { tags?: string[]; error?: string }[] }>('/api/imgbed/ai/tags', { method: 'POST', formData: form })
      const tags = result.results[0]?.tags ?? []
      if (!tags.length) { toast({ title: result.results[0]?.error ?? t('imgbed.ai.empty'), tone: 'warning' }); return }
      setAiTags(tags)
    } catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setAiBusy(false) }
  }
  const applyAi = async (): Promise<void> => {
    if (!aiTags?.length) return
    setAiBusy(true)
    try { await imgbedSetTags(file.id, aiTags, 'add'); toast({ title: t('imgbed.library.saved'), tone: 'success' }); onChanged() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
    finally { setAiBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={file.fileName} width={720} footer={
      <div className="flex flex-wrap justify-end gap-2">
        {aiEnabled && <Button size="sm" variant="secondary" loading={aiBusy} onClick={() => void (aiTags ? applyAi() : generateAi())}>{aiTags ? t('imgbed.ai.apply') : t('imgbed.ai.generate')}</Button>}
        <Button size="sm" variant="secondary" onClick={() => void tags()}>{t('imgbed.library.tags')}</Button>
        <Button size="sm" variant="secondary" onClick={() => void rename()}>{t('imgbed.library.rename')}</Button>
        <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>{t('imgbed.library.delete')}</Button>
      </div>
    }>
      <div className="grid gap-3 md:grid-cols-[1fr_260px]">
        <div className="flex min-h-[180px] items-center justify-center overflow-hidden rounded-[var(--r-md)] bg-[var(--bg-inset)]">
          {image ? <img src={`${url}?from=admin`} alt={file.fileName} className="max-h-[420px] max-w-full object-contain" /> : file.fileType.startsWith('video/') ? <video src={`${url}?from=admin`} controls className="max-h-[420px] max-w-full" /> : file.fileType.startsWith('audio/') ? <audio src={`${url}?from=admin`} controls /> : <FileText size={36} className="text-[var(--text-quaternary)]" />}
        </div>
        <dl className="space-y-1.5 text-[length:var(--text-11-5)]">
          <Row label={t('imgbed.library.channel')} value={`${file.channelName} (${file.channel})`} />
          <Row label={t('imgbed.library.size')} value={formatBytes(file.sizeBytes)} />
          <Row label={t('imgbed.library.access')} value={file.listType} />
          <Row label={t('imgbed.library.created')} value={new Date(file.createdAt).toLocaleString()} />
          {file.width && file.height ? <Row label={t('imgbed.library.size')} value={`${file.width} × ${file.height}`} /> : null}
          <Row label={t('imgbed.library.tags')} value={file.tags.join(', ') || '—'} />
          {aiTags && <Row label={t('imgbed.ai.title')} value={aiTags.join(', ')} />}
          <div className="flex flex-wrap gap-1 pt-2">
            <Button size="sm" variant="secondary" icon={<Copy size={12} />} onClick={() => void copyText(url).then((ok) => toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' }))}>{t('imgbed.upload.copy')}</Button>
            <a href={`${url}?download=1`} className="inline-flex min-h-8 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={12} />{t('imgbed.library.download')}</a>
          </div>
        </dl>
      </div>
    </Modal>
  )
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="flex gap-2"><dt className="w-20 shrink-0 text-[var(--text-quaternary)]">{label}</dt><dd className="min-w-0 break-all text-[var(--text-secondary)]">{value}</dd></div>
}
