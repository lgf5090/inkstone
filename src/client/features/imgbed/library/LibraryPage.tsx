import { useCallback, useEffect, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react'
import { downloadZip } from 'client-zip'
import { ArrowLeft, Copy, Download, ExternalLink, Eye, FileText, Folder, FolderInput, ListFilter, MoreHorizontal, PanelLeft, Pencil, Pin, RefreshCw, Search, Star, Tag, Trash2, X } from 'lucide-react'
import type { ImgbedFile, ImgbedListResult } from '@shared/imgbed/model'
import { imgbedChannelDisplayName, imgbedChannelLabel } from '@shared/imgbed/model'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input, Select } from '../../../components/form'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { Menu, Modal, confirm, prompt, useContextMenu, useEscape, type MenuItem } from '../../../components/overlay'
import { copyText } from '../../../lib/clipboard'
import { downloadBlob } from '../../../lib/export-note'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { imgbedApi, imgbedCopyLinks, imgbedDelete, imgbedFileLinks, imgbedList, imgbedMove, imgbedRename, imgbedSetAccess, imgbedSetFlags, imgbedSetTags, imgbedSidebar, type ImgbedSidebarResponse } from '../api'
import { cn } from '../../../lib/cn'
import { ImgbedSidebar, type ImgbedFilters } from './ImgbedSidebar'

const PAGE_SIZE = 30

const ACCESS_LABEL: Record<string, string> = {
  None: 'imgbed.library.normal',
  White: 'imgbed.library.white',
  Block: 'imgbed.library.blocked',
}

const LINK_LABEL: Record<string, string> = {
  originUrl: 'imgbed.link.origin_url',
  tgId: 'imgbed.link.tg_file_id',
  s3Location: 'imgbed.link.s3_key',
  s3CdnFileUrl: 'imgbed.link.s3_cdn_url',
  webdavPublicUrl: 'imgbed.link.webdav_public_url',
}

const TYPE_LABELS: Record<string, string> = {
  image: 'imgbed.public.images',
  video: 'imgbed.public.videos',
  audio: 'imgbed.public.audio',
  other: 'imgbed.public.other',
}

function accessLabel(listType: string): string {
  return t(ACCESS_LABEL[listType] as never)
}

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ImgbedFile | null>(null)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [quick, setQuick] = useState<ImgbedFilters['quick']>('all')
  const [tagFilter, setTagFilter] = useState('')
  const [sidebar, setSidebar] = useState<ImgbedSidebarResponse | null>(null)
  const [sidebarLoading, setSidebarLoading] = useState(true)
  const [sidebarHidden, setSidebarHidden] = useState(() => { try { return localStorage.getItem('inkstone.imgbed.sidebarHidden') === '1' } catch (error) { console.warn('[inkstone] Image bed sidebar preference is unreadable', error); return false } })
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [menuFile, setMenuFile] = useState<ImgbedFile | null>(null)
  const filtersTriggerRef = useRef<HTMLElement>(null)
  const menu = useContextMenu()
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; base: Set<string> } | null>(null)
  const toast = useUi((state) => state.toast)
  const globalScope = quick !== 'all' || Boolean(typeFilter) || Boolean(channelFilter) || Boolean(tagFilter)
  const filters: ImgbedFilters = { quick, type: typeFilter, channel: channelFilter, tag: tagFilter }
  const updateFilters = (patch: Partial<ImgbedFilters>): void => {
    if (patch.quick !== undefined) setQuick(patch.quick)
    if (patch.type !== undefined) setTypeFilter(patch.type)
    if (patch.channel !== undefined) setChannelFilter(patch.channel)
    if (patch.tag !== undefined) setTagFilter(patch.tag)
  }
  const closeFilters = (): void => {
    setFiltersOpen(false)
    window.setTimeout(() => filtersTriggerRef.current?.focus(), 0)
  }
  useEscape(filtersOpen, closeFilters)

  const onGridPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button,a,input,label,[data-imgbed-sidebar],[role=dialog]')) return
    dragRef.current = { x: event.clientX, y: event.clientY, base: new Set(selected) }
    setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onGridPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const left = Math.min(drag.x, event.clientX)
    const top = Math.min(drag.y, event.clientY)
    const width = Math.abs(event.clientX - drag.x)
    const height = Math.abs(event.clientY - drag.y)
    setMarquee({ left, top, width, height })
    const next = new Set(drag.base)
    gridRef.current?.querySelectorAll<HTMLElement>('[data-file-id]').forEach((element) => {
      const box = element.getBoundingClientRect()
      if (box.left < left + width && box.right > left && box.top < top + height && box.bottom > top) {
        const id = element.dataset.fileId
        if (id) next.add(id)
      }
    })
    setSelected(next)
  }
  const endMarquee = (): void => {
    dragRef.current = null
    setMarquee(null)
  }

  const load = useCallback(async (reset = true) => {
    setLoading(true)
    setError('')
    try {
      const offset = reset ? 0 : start
      const next = await imgbedList({
        dir: globalScope ? '' : dir, search, sort, count: PAGE_SIZE, start: offset,
        recursive: globalScope || Boolean(search),
        favorite: quick === 'favorite' || undefined,
        pinned: quick === 'pinned' || undefined,
        tagPrefix: tagFilter || undefined,
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
  }, [dir, search, sort, typeFilter, accessFilter, channelFilter, quick, tagFilter, globalScope, start])

  const loadSidebar = useCallback(async (): Promise<void> => {
    setSidebarLoading(true)
    try { setSidebar(await imgbedSidebar(-new Date().getTimezoneOffset(), 120)) }
    catch (error) { console.warn('[inkstone] Image bed sidebar counts failed to load', error); setSidebar(null) }
    finally { setSidebarLoading(false) }
  }, [])
  useEffect(() => { void load(true) }, [dir, search, sort, typeFilter, accessFilter, channelFilter, quick, tagFilter])
  useEffect(() => { void loadSidebar() }, [loadSidebar])

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
      await refresh()
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
      await refresh()
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

  const refresh = async (): Promise<void> => { await Promise.all([load(true), loadSidebar()]) }
  const toggleFlag = async (file: ImgbedFile, key: 'favorite' | 'pinned'): Promise<void> => {
    const next = !file[key]
    const patchFile = (entry: ImgbedFile): ImgbedFile => entry.id === file.id ? { ...entry, [key]: next } : entry
    setData((current) => current ? { ...current, files: current.files.map(patchFile) } : current)
    setDetail((current) => current ? patchFile(current) : current)
    try {
      await imgbedSetFlags([file.id], { [key]: next })
      await refresh()
    } catch (error) {
      setData((current) => current ? { ...current, files: current.files.map((entry) => entry.id === file.id ? { ...entry, [key]: !next } : entry) } : current)
      toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' })
    }
  }
  const absoluteFileUrl = (file: ImgbedFile): string => `${location.origin}/imgbed/file/${filePath(file.id)}`
  const copyFileLink = async (file: ImgbedFile): Promise<void> => {
    const ok = await copyText(absoluteFileUrl(file))
    toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' })
  }
  const copyFileMarkdown = async (file: ImgbedFile): Promise<void> => {
    const ok = await copyText(`![${file.fileName}](${absoluteFileUrl(file)})`)
    toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' })
  }
  const openFileInNewTab = (file: ImgbedFile): void => { window.open(absoluteFileUrl(file), '_blank', 'noopener,noreferrer') }
  const downloadFile = (file: ImgbedFile): void => {
    const anchor = document.createElement('a')
    anchor.href = `${absoluteFileUrl(file)}?download=1`
    anchor.download = file.fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }
  const tagFile = async (file: ImgbedFile): Promise<void> => {
    const value = await prompt({ title: t('imgbed.library.tags'), description: t('imgbed.library.tags_prompt'), defaultValue: file.tags.join(', ') })
    if (value === null) return
    try {
      await imgbedSetTags(file.id, value.split(',').map((tag) => tag.trim()).filter(Boolean), 'set')
      toast({ title: t('imgbed.library.saved'), tone: 'success' })
      await refresh()
    } catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const renameFile = async (file: ImgbedFile): Promise<void> => {
    const next = await prompt({ title: t('imgbed.library.rename'), description: t('imgbed.library.rename_prompt'), defaultValue: file.id })
    if (!next) return
    try { await imgbedRename(file.id, next); toast({ title: t('imgbed.library.saved'), tone: 'success' }); await refresh() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const moveFile = async (file: ImgbedFile): Promise<void> => {
    const dist = await prompt({ title: t('imgbed.library.move'), description: t('imgbed.library.move_prompt'), defaultValue: dir })
    if (dist === null) return
    try { await imgbedMove([file.id], dist); await refresh() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const deleteFile = async (file: ImgbedFile): Promise<void> => {
    if (!(await confirm({ title: t('imgbed.library.confirm_delete'), tone: 'danger', confirmLabel: t('imgbed.library.delete') }))) return
    try { await imgbedDelete(file.id); toast({ title: t('imgbed.library.deleted'), tone: 'success' }); setDetail(null); await refresh() }
    catch (error) { toast({ title: error instanceof Error ? error.message : t('imgbed.common.error'), tone: 'danger' }) }
  }
  const closeCardMenu = (): void => { menu.close(); setMenuFile(null) }
  const openCardMenu = (file: ImgbedFile, at: { x: number; y: number }): void => {
    setMenuFile(file)
    menu.openAt(at)
  }
  const cardMenuItems = (file: ImgbedFile): MenuItem[] => [
    { id: 'open', label: t('imgbed.library.preview' as never), icon: <Eye size={13} />, onSelect: () => setDetail(file) },
    { id: 'new-tab', label: t('imgbed.library.open_new_tab' as never), icon: <ExternalLink size={13} />, onSelect: () => openFileInNewTab(file) },
    { id: 'download', label: t('imgbed.library.download'), icon: <Download size={13} />, onSelect: () => downloadFile(file) },
    { id: 'copy', label: t('imgbed.upload.copy'), icon: <Copy size={13} />, onSelect: () => void copyFileLink(file) },
    { id: 'copy-md', label: t('imgbed.library.copy_markdown' as never), icon: <FileText size={13} />, onSelect: () => void copyFileMarkdown(file) },
    { id: 'favorite', label: t((file.favorite ? 'imgbed.library.unfavorite' : 'imgbed.library.favorite') as never), icon: <Star size={13} />, checked: file.favorite, separatorBefore: true, onSelect: () => void toggleFlag(file, 'favorite') },
    { id: 'pinned', label: t((file.pinned ? 'imgbed.library.unpin' : 'imgbed.library.pinned') as never), icon: <Pin size={13} />, checked: file.pinned, onSelect: () => void toggleFlag(file, 'pinned') },
    { id: 'tags', label: t('imgbed.library.tags'), icon: <Tag size={13} />, separatorBefore: true, onSelect: () => void tagFile(file) },
    { id: 'rename', label: t('imgbed.library.rename'), icon: <Pencil size={13} />, onSelect: () => void renameFile(file) },
    { id: 'move', label: t('imgbed.library.move'), icon: <FolderInput size={13} />, onSelect: () => void moveFile(file) },
    { id: 'delete', label: t('imgbed.library.delete'), icon: <Trash2 size={13} />, tone: 'danger', separatorBefore: true, onSelect: () => void deleteFile(file) },
  ]
  const up = (): void => {
    const parts = dir.split('/').filter(Boolean)
    parts.pop()
    setDir(parts.length ? `${parts.join('/')}/` : '')
  }

  return (
    <div
      ref={gridRef}
      className="flex min-h-full"
      onPointerDown={onGridPointerDown}
      onPointerMove={onGridPointerMove}
      onPointerUp={endMarquee}
      onPointerCancel={endMarquee}
    >
      <aside inert={filtersOpen || undefined} data-imgbed-sidebar className={cn('hidden w-[236px] shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] lg:block', sidebarHidden && 'lg:hidden')}>
        <ImgbedSidebar data={sidebar} loading={sidebarLoading} filters={filters} onChange={updateFilters} />
      </aside>
      <div inert={filtersOpen || undefined} className="flex min-w-0 flex-1 flex-col gap-3 p-3 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span ref={filtersTriggerRef} className="lg:hidden"><IconButton label={t('imgbed.library.filters' as never)} onClick={() => setFiltersOpen(true)}><ListFilter size={15} /></IconButton></span>
        <span className="hidden lg:inline-flex"><IconButton label={t((sidebarHidden ? 'imgbed.library.sidebar_show' : 'imgbed.library.sidebar_hide') as never)} onClick={() => setSidebarHidden((current) => { const next = !current; try { localStorage.setItem('inkstone.imgbed.sidebarHidden', next ? '1' : '0') } catch (error) { console.warn('[inkstone] Image bed sidebar preference could not be saved', error) } return next })}><PanelLeft size={15} /></IconButton></span>
        <IconButton label={t('imgbed.library.folder_up')} onClick={up} disabled={!dir || globalScope}><ArrowLeft size={15} /></IconButton>
        <div className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-tertiary)]">{globalScope || !dir ? t('imgbed.library.all_files' as never) : `/${dir}`}</div>
        <div className="order-last w-full min-w-[200px] sm:order-none sm:w-auto sm:min-w-[220px] sm:flex-1">
          <Input leading={<Search size={13} />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('imgbed.library.search')} />
        </div>
        <Select value={accessFilter} onChange={(event) => setAccessFilter(event.target.value)} className="w-[112px]">
          <option value="">{t('imgbed.library.access')}</option>
          <option value="normal">{t('imgbed.library.normal')}</option>
          <option value="blocked">{t('imgbed.library.blocked')}</option>
        </Select>
        <Select value={sort} onChange={(event) => setSort(event.target.value)} className="w-[116px]">
          <option value="time">{t('imgbed.sort.time' as never)}</option>
          <option value="size">{t('imgbed.sort.size' as never)}</option>
          <option value="fileName">{t('imgbed.sort.file_name' as never)}</option>
        </Select>
        <IconButton label={t('imgbed.common.retry')} onClick={() => void refresh()}><RefreshCw size={15} /></IconButton>
      </div>
      {globalScope ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('imgbed.library.showing_all' as never)}</span>
          {quick !== 'all' ? <FilterChip label={t((quick === 'favorite' ? 'imgbed.library.favorite' : 'imgbed.library.pinned') as never)} onClear={() => setQuick('all')} /> : null}
          {typeFilter ? <FilterChip label={t((TYPE_LABELS[typeFilter] ?? 'imgbed.public.all') as never)} onClear={() => setTypeFilter('')} /> : null}
          {channelFilter ? <FilterChip label={imgbedChannelLabel(channelFilter)} onClear={() => setChannelFilter('')} /> : null}
          {tagFilter ? <FilterChip label={`#${tagFilter}`} onClear={() => setTagFilter('')} /> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Checkbox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(data?.files.map((file) => file.id) ?? []))} label={t('imgbed.library.select_all')} />
        {ids.length > 0 && <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('imgbed.library.selected', { count: ids.length })}</span>}
        {ids.length > 0 && (
          <div className="hidden flex-wrap items-center gap-1 md:flex">
            <Button size="sm" variant="secondary" icon={<Copy size={13} />} onClick={() => void copySelected()}>{t('imgbed.library.copy_links')}</Button>
            <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => void downloadSelected()}>{t('imgbed.library.download')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void moveSelected()}>{t('imgbed.library.move')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void tagSelected()}>{t('imgbed.library.tags')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void accessSelected('White')}>{t('imgbed.library.white')}</Button>
            <Button size="sm" variant="secondary" onClick={() => void accessSelected('Block')}>{t('imgbed.library.blocked')}</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void deleteSelected()}>{t('imgbed.library.delete')}</Button>
          </div>
        )}
        {ids.length > 0 && <Button size="sm" variant="secondary" className="md:hidden" onClick={() => setActionsOpen(true)}>{t('imgbed.library.actions')}</Button>}
      </div>

      {loading ? <LoadingBlock label={t('imgbed.common.loading')} /> : error ? (
        <Empty art="search" title={error} action={<Button onClick={() => void load()}>{t('imgbed.common.retry')}</Button>} />
      ) : !data?.files.length && !data?.directories.length ? (
        <Empty art="search" title={t('imgbed.library.empty')} />
      ) : (
        <div className="flex flex-col gap-3">
          {marquee && <div className="pointer-events-none fixed z-50 border border-[var(--accent)] bg-[var(--accent-soft)]/20" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} />}
          {!globalScope && data.directories.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
              {data.directories.map((directory) => (
                <button
                  key={directory}
                  type="button"
                  onClick={() => setDir(directory)}
                  className="flex min-h-[64px] items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <Folder size={18} className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{directory.split('/').filter(Boolean).pop()}</span>
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {data.files.map((file) => {
            const image = file.fileType.startsWith('image/') && file.fileType !== 'image/svg+xml'
            return (
              <div
                key={file.id}
                data-file-id={file.id}
                className="group relative overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]"
                onContextMenu={(event) => { setMenuFile(file); menu.onContextMenu(event) }}
              >
                <div className="absolute left-1.5 top-1.5 z-20 rounded bg-[var(--bg-overlay)]/80 p-0.5">
                  <Checkbox checked={selected.has(file.id)} onChange={() => toggle(file.id)} ariaLabel={file.id} />
                </div>
                <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--bg-overlay)]/90 p-0.5 opacity-100 shadow-[var(--shadow-pop)] transition-opacity duration-[var(--dur-fast)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <IconButton size="xs" data-card-action="favorite" label={t((file.favorite ? 'imgbed.library.unfavorite' : 'imgbed.library.favorite') as never)} active={file.favorite} onClick={() => void toggleFlag(file, 'favorite')}><Star size={12} /></IconButton>
                  <IconButton size="xs" className="hidden sm:inline-flex" data-card-action="pinned" label={t((file.pinned ? 'imgbed.library.unpin' : 'imgbed.library.pinned') as never)} active={file.pinned} onClick={() => void toggleFlag(file, 'pinned')}><Pin size={12} /></IconButton>
                  <IconButton size="xs" className="hidden sm:inline-flex" data-card-action="copy" label={t('imgbed.upload.copy')} onClick={() => void copyFileLink(file)}><Copy size={12} /></IconButton>
                  <IconButton size="xs" className="hidden sm:inline-flex" data-card-action="tags" label={t('imgbed.library.tags')} onClick={() => void tagFile(file)}><Tag size={12} /></IconButton>
                  <IconButton size="xs" data-card-action="more" label={t('imgbed.library.more_actions' as never)} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openCardMenu(file, { x: rect.left, y: rect.bottom + 4 }) }}><MoreHorizontal size={12} /></IconButton>
                </div>
                <button
                  type="button"
                  onClick={() => setDetail(file)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    openCardMenu(file, { x: rect.left + 12, y: rect.top + 12 })
                  }}
                  className="block w-full text-left"
                >
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-inset)]">
                    {image
                      ? <img src={`/imgbed/file/${filePath(file.id)}?from=admin`} alt={file.fileName} loading="lazy" decoding="async" className="size-full object-cover" />
                      : <FileText size={26} className="text-[var(--text-quaternary)]" />}
                  </div>
                  <div className="px-2 py-1.5">
                    <div className="truncate text-[length:var(--text-11-5)] text-[var(--text-primary)]">{file.fileName}</div>
                    <div className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                      <span className="min-w-0 flex-1 truncate">{formatBytes(file.sizeBytes)} · {imgbedChannelDisplayName(file.channelName)}</span>
                      {file.pinned ? <Pin size={10} aria-hidden="true" className="shrink-0 text-[var(--warning)]" /> : null}
                      {file.favorite ? <Star size={10} aria-hidden="true" className="shrink-0 text-[var(--warning)]" /> : null}
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
          </div>
        </div>
      )}

      </div>

      {filtersOpen ? (
        <div className="fixed inset-0 z-[var(--z-drawer)] lg:hidden">
          <button type="button" tabIndex={-1} aria-label={t('imgbed.common.close')} className="absolute inset-0 bg-[var(--scrim)]" onClick={closeFilters} />
          <div role="dialog" aria-modal="true" aria-label={t('imgbed.library.filters' as never)} className="absolute inset-y-0 left-0 flex w-[286px] max-w-[86vw] flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] shadow-[var(--shadow-modal)]">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('imgbed.library.filters' as never)}</span>
              <IconButton autoFocus label={t('imgbed.common.close')} onClick={closeFilters}><X size={15} /></IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden"><ImgbedSidebar data={sidebar} loading={sidebarLoading} filters={filters} onChange={updateFilters} /></div>
          </div>
        </div>
      ) : null}

      <Menu anchor={menu.point ?? { x: 0, y: 0 }} open={Boolean(menu.point && menuFile)} onClose={closeCardMenu} items={menuFile ? cardMenuItems(menuFile).map((item) => ({ ...item, onSelect: () => { closeCardMenu(); item.onSelect?.() } })) : []} width={224} label={t('imgbed.library.more_actions' as never)} />

      <Modal open={actionsOpen} onClose={() => setActionsOpen(false)} title={t('imgbed.library.actions' as never)} width={360}>
        <div className="flex flex-col gap-2">
          {[
            { label: t('imgbed.library.copy_links'), run: copySelected, danger: false },
            { label: t('imgbed.library.download'), run: downloadSelected, danger: false },
            { label: t('imgbed.library.move'), run: moveSelected, danger: false },
            { label: t('imgbed.library.tags'), run: tagSelected, danger: false },
            { label: t('imgbed.library.white'), run: () => accessSelected('White'), danger: false },
            { label: t('imgbed.library.blocked'), run: () => accessSelected('Block'), danger: false },
            { label: t('imgbed.library.delete'), run: deleteSelected, danger: true },
          ].map((action) => (
            <Button key={action.label} variant={action.danger ? 'danger' : 'secondary'} onClick={() => { setActionsOpen(false); void action.run() }}>{action.label}</Button>
          ))}
        </div>
      </Modal>

      <FileDetail file={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); void refresh() }} onToggleFlag={(file, key) => void toggleFlag(file, key)} />
    </div>
  )
}

function FileDetail({ file, onClose, onChanged, onToggleFlag }: { file: ImgbedFile | null; onClose: () => void; onChanged: () => void; onToggleFlag: (file: ImgbedFile, key: 'favorite' | 'pinned') => void }): ReactElement {
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiTags, setAiTags] = useState<string[] | null>(null)
  const [moreLinks, setMoreLinks] = useState<{ kind: string; value: string }[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  useEffect(() => {
    if (!file) return
    imgbedApi<{ enabled: boolean }>('/api/imgbed/ai/tags').then((result) => setAiEnabled(result.enabled)).catch(() => setAiEnabled(false))
  }, [file?.id])
  if (!file) return <Modal open={false} onClose={onClose} title="">{null}</Modal>
  const url = `/imgbed/file/${filePath(file.id)}`
  const channelLabel = imgbedChannelLabel(file.channel)
  const channelDisplay = imgbedChannelDisplayName(file.channelName)
  const channelValue = channelDisplay === channelLabel ? channelDisplay : `${channelDisplay} (${channelLabel})`
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <IconButton label={t((file.favorite ? 'imgbed.library.unfavorite' : 'imgbed.library.favorite') as never)} active={file.favorite} onClick={() => onToggleFlag(file, 'favorite')}><Star size={14} /></IconButton>
        <IconButton label={t((file.pinned ? 'imgbed.library.unpin' : 'imgbed.library.pinned') as never)} active={file.pinned} onClick={() => onToggleFlag(file, 'pinned')}><Pin size={14} /></IconButton>
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
          <Row label={t('imgbed.library.channel')} value={channelValue} />
          <Row label={t('imgbed.library.size')} value={formatBytes(file.sizeBytes)} />
          <Row label={t('imgbed.library.access')} value={accessLabel(file.listType)} />
          <Row label={t('imgbed.library.created')} value={new Date(file.createdAt).toLocaleString()} />
          {file.width && file.height ? <Row label={t('imgbed.library.dimensions' as never)} value={`${file.width} × ${file.height}`} /> : null}
          <Row label={t('imgbed.library.tags')} value={file.tags.join(', ') || '—'} />
          {aiTags && <Row label={t('imgbed.ai.title')} value={aiTags.join(', ')} />}
          <div className="flex flex-wrap gap-1 pt-2">
            <Button size="sm" variant="secondary" icon={<Copy size={12} />} onClick={() => void copyText(url).then((ok) => toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' }))}>{t('imgbed.upload.copy')}</Button>
            <Button size="sm" variant="secondary" onClick={() => {
              if (moreLinks) { setMoreLinks(null); return }
              imgbedFileLinks(file.id).then(setMoreLinks).catch((reason: Error) => toast({ title: reason.message, tone: 'danger' }))
            }}>{t('imgbed.library.more_links' as never)}</Button>
            <a href={`${url}?download=1`} className="inline-flex min-h-8 items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Download size={12} />{t('imgbed.library.download')}</a>
          </div>
          {moreLinks && <ul className="space-y-1 pt-1">{moreLinks.map((link) => {
            const value = link.value.startsWith('/') ? `${location.origin}${link.value}` : link.value
            return <li key={link.kind} className="flex items-center gap-1"><span className="w-24 shrink-0 text-[var(--text-quaternary)]">{t((LINK_LABEL[link.kind] ?? link.kind) as never)}</span><code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-10-5)] text-[var(--text-secondary)]">{value}</code><IconButton label={t('imgbed.upload.copy')} onClick={() => void copyText(value).then((ok) => toast({ title: ok ? t('imgbed.upload.copied') : t('imgbed.common.error'), tone: ok ? 'success' : 'danger' }))}><Copy size={12} /></IconButton></li>
          })}</ul>}
        </dl>
      </div>
    </Modal>
  )
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-10-5)] text-[var(--accent-on-soft)]">
      {label}
      <button type="button" aria-label={t('imgbed.library.clear_filter' as never)} onClick={onClear} className="rounded-full p-0.5 hover:bg-[var(--bg-hover)]"><X size={10} /></button>
    </span>
  )
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return <div className="flex gap-2"><dt className="w-20 shrink-0 text-[var(--text-quaternary)]">{label}</dt><dd className="min-w-0 break-all text-[var(--text-secondary)]">{value}</dd></div>
}
