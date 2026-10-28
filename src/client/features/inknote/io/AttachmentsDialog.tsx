/** The attachment shelf: upload, open, list and delete files that belong to one note. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Paperclip, Trash2 } from 'lucide-react'
import type { InknoteAsset, InknoteNoteMeta } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Modal, confirm } from '../../../components/overlay'
import { inknoteApi } from '../api'
import { useUi } from '../../../store/ui'

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AttachmentsDialog({ open, onClose, note }: { open: boolean; onClose: () => void; note: InknoteNoteMeta | null }) {
  const toast = useUi((state) => state.toast)
  const [assets, setAssets] = useState<InknoteAsset[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!note) { setAssets([]); return }
    setLoading(true)
    setError(null)
    try {
      const response = await inknoteApi.assets(note.id, 'attachment')
      setAssets(response.assets)
    } catch (reason) {
      setError(String(reason))
      setAssets([])
    } finally {
      setLoading(false)
    }
  }, [note])

  useEffect(() => { if (open) void load() }, [open, load])

  const upload = async (file: File) => {
    if (!note) return
    setUploading(true)
    try {
      await inknoteApi.uploadAsset(file, 'attachment', note.id)
      await load()
      toast({ title: t('inknote.attachments.uploaded') })
    } catch (reason) {
      toast({ title: String(reason), tone: 'danger' })
    } finally {
      setUploading(false)
    }
  }

  const remove = async (asset: InknoteAsset) => {
    const ok = await confirm({ title: t('inknote.attachments.delete'), description: t('inknote.attachments.delete_confirm'), confirmLabel: t('inknote.delete') })
    if (!ok) return
    try {
      await inknoteApi.deleteAsset(asset.id)
      await load()
    } catch (reason) {
      toast({ title: String(reason), tone: 'danger' })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.attachments.title')} width={520}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.attachments.hint')}</span>
          <Button size="sm" variant="secondary" icon={<Paperclip size={13}/>} loading={uploading} disabled={!note} onClick={() => inputRef.current?.click()}>{t('inknote.attachments.add')}</Button>
        </div>
        <input ref={inputRef} type="file" hidden onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file)
        }}/>
        {loading && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">…</p>}
        {error && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {!loading && !error && assets.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.attachments.empty')}</p>}
        <div className="max-h-72 overflow-y-auto">
          {assets.map((asset) => (
            <div key={asset.id} className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-1 py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)]" title={asset.filename}>{asset.filename}</span>
              <span className="shrink-0 text-[length:var(--text-10-5)] tabular-nums text-[var(--text-tertiary)]">{sizeLabel(asset.size)}</span>
              <IconButton label={t('inknote.attachments.open')} size="xs" onClick={() => window.open(asset.url, '_blank', 'noopener,noreferrer')}><Download size={12}/></IconButton>
              <IconButton label={t('inknote.attachments.delete')} size="xs" onClick={() => void remove(asset)}><Trash2 size={12}/></IconButton>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
