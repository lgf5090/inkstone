import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlogMediaItem } from '@shared/blog/model'
import { FileText, Image as ImageIcon, Music, Video } from 'lucide-react'
import { Button, Spinner } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'

const PAGE_SIZE = 60

const KIND_ICON: Record<string, typeof FileText> = {
  image: ImageIcon,
  audio: Music,
  video: Video,
  file: FileText,
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(2)} MiB`
}

export function MediaPanel() {
  const [items, setItems] = useState<BlogMediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [kind, setKind] = useState('')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.blog.media.list({ page, limit: PAGE_SIZE, kind: kind || undefined, q: search || undefined })
      setItems(result.items)
      setTotal(result.total)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [kind, page, search])

  useEffect(() => {
    void load()
  }, [load])

  const upload = async (file: File) => {
    setUploading(true)
    setError('')
    try {
      await api.blog.media.upload(file)
      toast({ title: t('blog.admin.media_uploaded'), tone: 'success' })
      setPage(1)
      await load()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast({ title: t('blog.admin.media_upload_failed'), description: message, tone: 'danger' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const copy = async (item: BlogMediaItem) => {
    try {
      await navigator.clipboard.writeText(new URL(item.url, window.location.origin).href)
      toast({ title: t('blog.admin.media_copied'), tone: 'success' })
    } catch {
      toast({ title: t('blog.admin.media_upload_failed'), tone: 'danger' })
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
    setError('')
    try {
      await api.blog.media.remove(item.id)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Field label={t('blog.admin.media_kind')}>
              <Select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }}>
                <option value="">{t('blog.admin.media_all')}</option>
                <option value="image">{t('blog.admin.media_images')}</option>
                <option value="audio">{t('blog.admin.media_audio')}</option>
                <option value="video">{t('blog.admin.media_video')}</option>
                <option value="file">{t('blog.admin.media_files')}</option>
              </Select>
            </Field>
          </div>
          <div className="w-56">
            <Field label={t('blog.admin.media_search')}>
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
            </Field>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,audio/*,video/*,application/pdf,text/plain,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
            }}
          />
          <Button onClick={() => fileRef.current?.click()} loading={uploading}>{t('blog.admin.media_upload')}</Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner /> {t('blog.admin.loading')}</div>
      ) : items.length === 0 ? (
        <p className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('blog.admin.media_empty')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind] ?? FileText
            return (
              <article key={item.id} className="group overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-inset)]">
                  {item.kind === 'image'
                    ? <img src={item.url} alt={item.filename} loading="lazy" decoding="async" className="size-full object-cover" />
                    : <Icon size={28} className="text-[var(--text-quaternary)]" aria-hidden="true" />}
                </div>
                <div className="space-y-1 p-3">
                  <p className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]" title={item.filename}>{item.filename}</p>
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatBytes(item.size)}</p>
                  <div className="flex justify-end gap-1 pt-1">
                    <Button size="sm" variant="ghost" onClick={() => void copy(item)}>{t('blog.admin.media_copy')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(item)}>{t('blog.admin.media_delete')}</Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('blog.admin.previous')}</Button>
          <span className="tabular-nums">{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>{t('blog.admin.next')}</Button>
        </div>
      )}
    </section>
  )
}
