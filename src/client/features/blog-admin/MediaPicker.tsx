import { useRef, useState } from 'react'
import { Image as ImageIcon, Upload } from 'lucide-react'
import type { BlogMediaItem } from '@shared/blog/model'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminEmpty, AdminError, AdminLoading, SearchField, formatBytes, useAdminResource, useDebounced } from './shared'

export function MediaPicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  onSelect: (item: BlogMediaItem) => void
}) {
  const toast = useUi((state) => state.toast)
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 300)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const media = useAdminResource(
    () => api.blog.media.list({ limit: 60, q: debounced }),
    [debounced],
  )

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files).slice(0, 10)) {
        await api.blog.media.upload(file)
      }
      await media.reload()
    } catch (error) {
      toast({
        title: t('blog.admin.media_upload_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('blog.admin.select_media')} width={820}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.search_media')} />
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*,application/pdf,text/*"
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
          <Button size="sm" icon={<Upload size={13} />} loading={uploading} onClick={() => inputRef.current?.click()}>{t('blog.admin.upload')}</Button>
        </div>
        {media.error ? (
          <AdminError message={media.error} onRetry={() => void media.reload()} />
        ) : !media.data ? (
          <AdminLoading />
        ) : media.data.items.length === 0 ? (
          <AdminEmpty>{t('blog.admin.no_media')}</AdminEmpty>
        ) : (
          <ul className="grid max-h-[55vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
            {media.data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => { onSelect(item); onClose() }}
                  className="group block w-full overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-left transition-colors hover:border-[var(--accent)]"
                >
                  <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-inset)]">
                    {item.mime.startsWith('image/') ? (
                      <img src={item.url} alt="" loading="lazy" className="size-full object-cover" />
                    ) : (
                      <ImageIcon size={22} aria-hidden="true" className="text-[var(--text-quaternary)]" />
                    )}
                  </span>
                  <span className="block truncate px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-primary)]">{item.filename}</span>
                  <span className="block px-2 pb-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatBytes(item.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
