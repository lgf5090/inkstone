import { useRef, useState } from 'react'
import { Archive, Download, Plus, Trash2, UploadCloud } from 'lucide-react'
import { downloadZip } from 'client-zip'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useIdPhotoStore } from '../store'
import { IdPhotoEngine } from '../engine/id-photo-engine'

interface BatchItem {
  id: string
  name: string
  file: File
  imgUrl: string
  imgElement: HTMLImageElement
}

export function IdPhotoBatchView() {
  const [items, setItems] = useState<BatchItem[]>([])
  const [processing, setProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const exportFormat = useIdPhotoStore((s) => s.exportFormat)

  const activeSpec = getActiveSpec()

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return

    const newItems: BatchItem[] = []
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        newItems.push({
          id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: file.name.replace(/\.[^/.]+$/, ''),
          file,
          imgUrl: url,
          imgElement: img,
        })
        if (newItems.length === files.length) {
          setItems((prev) => [...prev, ...newItems])
        }
      }
      img.src = url
    })
  }

  const handleExportZip = async () => {
    if (items.length === 0) return
    setProcessing(true)
    try {
      const engine = new IdPhotoEngine(activeSpec, adjustOptions)
      const zipFiles: Array<{ name: string; input: Blob }> = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const blob = await engine.exportBlob(item.imgElement, exportFormat)
        zipFiles.push({
          name: `${item.name}-${activeSpec.id}.${exportFormat}`,
          input: blob,
        })
      }

      const zipBlob = await downloadZip(zipFiles).blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(zipBlob)
      a.download = `idphotos-batch-${Date.now()}.zip`
      a.click()

      useUi.getState().toast({
        title: t('tools.id_photo.batch.export_zip'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setProcessing(false)
    }
  }

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-5xl mx-auto gap-5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/jpg"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <Archive size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.batch.title')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.batch.desc')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={14} className="mr-1" />
            <span>{t('tools.id_photo.batch.upload_btn')}</span>
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={items.length === 0 || processing}
            onClick={handleExportZip}
          >
            <Download size={14} className="mr-1" />
            <span>{t('tools.id_photo.batch.export_zip')}</span>
          </Button>
        </div>
      </div>

      {/* Batch Cards Grid */}
      {items.length === 0 ? (
        <div className="relative flex w-full flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border-2 border-dashed border-[var(--border-subtle)] p-12 text-center cursor-pointer hover:border-[var(--accent)] hover:bg-[var(--bg-hover)] select-none">
          <button
            type="button"
            aria-label={t('tools.id_photo.batch.upload_btn')}
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 z-[var(--z-sticky)] rounded-[var(--r-lg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          />
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--accent)]">
            <UploadCloud size={24} />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">
              {t('tools.id_photo.batch.upload_btn')}
            </p>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.content.upload_drag_hint')}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>{t('tools.id_photo.batch.items_count', { count: items.length })}</span>
            <span>
              {t('tools.id_photo.common.target_spec')}: {activeSpec.flagEmoji} {activeSpec.nameKey ? t(activeSpec.nameKey as any) : activeSpec.name} ({activeSpec.widthPx}×{activeSpec.heightPx} {t('tools.id_photo.unit.px')})
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="relative flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 shadow-xs group"
              >
                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-base)]">
                  <img src={item.imgUrl} alt={item.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label={`${t('tools.id_photo.common.delete')}: ${item.name}`}
                    onClick={() => removeItem(item.id)}
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-rose-600 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <span className="truncate pt-1.5 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                  {item.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
