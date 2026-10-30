import { useMemo, useRef, useState } from 'react'
import { FileText, Grid2X2, Image as ImageIcon, List, Music, Upload, Video } from 'lucide-react'
import type { BlogMediaItem } from '@shared/blog/model'
import { Button, IconButton } from '../../components/primitives'
import { Field, Select } from '../../components/form'
import { Drawer, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  PageHeader,
  SearchField,
  formatBytes,
  formatDateTime,
  useAdminResource,
  useDebounced,
} from './shared'

const PAGE_SIZE = 60
const KIND_ICON: Record<string, typeof FileText> = { image: ImageIcon, audio: Music, video: Video, file: FileText }
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,audio/*,video/*,application/pdf,text/plain,application/zip'

export function MediaPanel() {
  const toast = useUi((state) => state.toast)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState<BlogMediaItem | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(query, 300)
  const media = useAdminResource(
    () => api.blog.media.list({ page, limit: PAGE_SIZE, kind: kind || undefined, q: debounced || undefined }),
    [page, kind, debounced],
  )
  const items = media.data?.items ?? []
  const total = media.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + item.size, 0), [items])

  const upload = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    setUploading(list.length)
    let uploaded = 0
    let failed = 0
    for (const file of list.slice(0, 20)) {
      try {
        await api.blog.media.upload(file)
        uploaded += 1
      } catch (error) {
        failed += 1
        toast({
          title: t('blog.admin.media_upload_failed'),
          description: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          tone: 'danger',
        })
      } finally {
        setUploading((count) => Math.max(0, count - 1))
      }
    }
    if (uploaded > 0) {
      toast({ title: t('blog.admin.media_uploaded_count', { count: uploaded }), tone: 'success' })
      setPage(1)
      await media.reload()
    }
    if (failed === 0 && fileRef.current) fileRef.current.value = ''
  }

  const copy = async (item: BlogMediaItem) => {
    try {
      await navigator.clipboard.writeText(new URL(item.url, window.location.origin).href)
      toast({ title: t('blog.admin.media_copied'), tone: 'success' })
    } catch {
      toast({ title: t('blog.admin.media_copy_failed'), tone: 'danger' })
    }
  }

  const remove = async (item: BlogMediaItem) => {
    const ok = await confirm({
      title: t('blog.admin.media_delete_title'),
      description: t('blog.admin.media_delete_desc'),
      confirmLabel: t('blog.admin.media_delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.blog.media.remove(item.id)
      setSelected(null)
      await media.reload()
    } catch (error) {
      toast({ title: t('blog.admin.delete_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={t('blog.admin.media')}
        description={t('blog.admin.media_subtitle')}
        actions={<Button size="sm" icon={<Upload size={13} />} loading={uploading > 0} onClick={() => fileRef.current?.click()}>{t('blog.admin.upload')}</Button>}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        accept={ACCEPT}
        onChange={(event) => void upload(event.target.files)}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={(value) => { setQuery(value); setPage(1) }} placeholder={t('blog.admin.media_search')} className="max-w-xs" />
        <Select aria-label={t('blog.admin.media_kind')} value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} className="w-auto min-w-[120px]">
          <option value="">{t('blog.admin.media_all')}</option>
          <option value="image">{t('blog.admin.media_images')}</option>
          <option value="audio">{t('blog.admin.media_audio')}</option>
          <option value="video">{t('blog.admin.media_video')}</option>
          <option value="file">{t('blog.admin.media_files')}</option>
        </Select>
        <div className="ml-auto flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          <span>{t('blog.admin.media_summary', { count: total, size: formatBytes(totalBytes) })}</span>
          <div role="group" aria-label={t('blog.admin.media_view')} className="flex rounded-[var(--r-md)] border border-[var(--border-subtle)] p-0.5">
            <IconButton label={t('blog.admin.media_grid')} size="sm" active={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={13} /></IconButton>
            <IconButton label={t('blog.admin.media_list')} size="sm" active={view === 'list'} onClick={() => setView('list')}><List size={13} /></IconButton>
          </div>
        </div>
      </div>

      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files) }}
        className={dragging ? 'rounded-[var(--r-lg)] outline-2 outline-dashed outline-[var(--accent)]' : undefined}
      >
        {media.error ? (
          <AdminError message={media.error} onRetry={() => void media.reload()} />
        ) : !media.data ? (
          <AdminLoading />
        ) : items.length === 0 ? (
          <AdminEmpty>{t('blog.admin.media_empty')}</AdminEmpty>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => {
              const Icon = KIND_ICON[item.kind] ?? FileText
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(item)}
                    className="group block w-full overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-left transition-colors hover:border-[var(--accent)]"
                  >
                    <span className="flex aspect-square items-center justify-center overflow-hidden bg-[var(--bg-inset)]">
                      {item.kind === 'image'
                        ? <img src={item.url} alt={item.filename} loading="lazy" decoding="async" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
                        : <Icon size={28} className="text-[var(--text-quaternary)]" aria-hidden="true" />}
                    </span>
                    <span className="block truncate px-2 pt-1.5 text-[length:var(--text-11-5)] font-medium text-[var(--text-primary)]">{item.filename}</span>
                    <span className="block px-2 pb-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatBytes(item.size)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <AdminCard className="overflow-hidden">
            <ul className="divide-y divide-[var(--border-subtle)]">
              {items.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? FileText
                return (
                  <li key={item.id}>
                    <button type="button" onClick={() => setSelected(item)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--bg-hover)]">
                      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-inset)]">
                        {item.kind === 'image' ? <img src={item.url} alt="" loading="lazy" className="size-full object-cover" /> : <Icon size={16} className="text-[var(--text-quaternary)]" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{item.filename}</span>
                      <span className="w-20 shrink-0 text-right text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatBytes(item.size)}</span>
                      <span className="hidden w-36 shrink-0 text-right text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:block">{formatDateTime(item.createdAt)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </AdminCard>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('blog.admin.previous')}</Button>
          <span>{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>{t('blog.admin.next')}</Button>
        </div>
      )}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} side="right" width={420} title={t('blog.admin.media_details')}>
        {selected && (
          <div className="space-y-4 p-4">
            <div className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]">
              {selected.kind === 'image'
                ? <img src={selected.url} alt={selected.filename} className="max-h-[40vh] w-full object-contain" />
                : selected.kind === 'video'
                  ? <video src={selected.url} controls className="w-full" />
                  : selected.kind === 'audio'
                    ? <audio src={selected.url} controls className="w-full p-4" />
                    : <div className="flex h-40 items-center justify-center"><FileText size={32} className="text-[var(--text-quaternary)]" /></div>}
            </div>
            <dl className="space-y-2 text-[length:var(--text-11-5)]">
              <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.media_filename')}</dt><dd className="break-all text-[var(--text-primary)]">{selected.filename}</dd></div>
              <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.media_type')}</dt><dd className="text-[var(--text-primary)]">{selected.mime}</dd></div>
              <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.media_size')}</dt><dd className="text-[var(--text-primary)]">{formatBytes(selected.size)}</dd></div>
              {(selected.width || selected.height) && <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.media_dimensions')}</dt><dd className="text-[var(--text-primary)]">{selected.width ?? '?'} × {selected.height ?? '?'}</dd></div>}
              <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.media_uploaded')}</dt><dd className="text-[var(--text-primary)]">{formatDateTime(selected.createdAt)}</dd></div>
            </dl>
            <div className="space-y-2">
              <Field label={t('blog.admin.media_url')}>
                <input readOnly value={new URL(selected.url, window.location.origin).href} onFocus={(event) => event.target.select()} className="h-11 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2 text-[length:var(--text-11)] text-[var(--text-secondary)] md:h-[34px]" />
              </Field>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void copy(selected)}>{t('blog.admin.media_copy')}</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(selected)}>{t('blog.admin.media_delete')}</Button>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
