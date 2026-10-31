import { useEffect, useRef, useState } from 'react'
import { Archive, Download, Plus, Trash2, UploadCloud } from 'lucide-react'
import { downloadZip } from 'client-zip'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useIdPhotoStore } from '../store'
import { IdPhotoEngine } from '../engine/id-photo-engine'

const MAX_BATCH_ITEMS = 60
const UNSUPPORTED_MIME = /^image\/(heic|heif|tiff|svg\+xml)$/i

interface BatchItem {
  id: string
  name: string
  file: File
  imgUrl: string
}

let batchSequence = 0

function shortName(fileName: string) {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode failed'))
    img.src = url
  })
}

export function IdPhotoBatchView() {
  const [items, setItems] = useState<BatchItem[]>([])
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const itemsRef = useRef<BatchItem[]>([])

  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const exportFormat = useIdPhotoStore((s) => s.exportFormat)
  const targetMaxKb = useIdPhotoStore((s) => s.targetMaxKb)

  const activeSpec = getActiveSpec()

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.imgUrl))
    },
    [],
  )

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const incoming = Array.from(files)
    const supported = incoming.filter((file) => file.type.startsWith('image/') && !UNSUPPORTED_MIME.test(file.type))
    const rejected = incoming.length - supported.length

    const room = Math.max(0, MAX_BATCH_ITEMS - items.length)
    const taken = supported.slice(0, room)
    const overflow = supported.length - taken.length

    if (taken.length) {
      const added = taken.map((file) => ({
        id: `batch_${Date.now()}_${batchSequence++}`,
        name: shortName(file.name),
        file,
        imgUrl: URL.createObjectURL(file),
      }))
      setItems((prev) => [...prev, ...added])
    }

    if (rejected > 0) {
      useUi.getState().toast({
        title: t('tools.id_photo.batch.rejected', { count: rejected }),
        tone: 'danger',
      })
    }
    if (overflow > 0) {
      useUi.getState().toast({
        title: t('tools.id_photo.batch.limit', { max: MAX_BATCH_ITEMS }),
        tone: 'warning',
      })
    }
  }

  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.imgUrl)
      return prev.filter((item) => item.id !== id)
    })
  }

  const handleExportZip = async () => {
    if (items.length === 0) return
    const engine = new IdPhotoEngine(activeSpec, adjustOptions)
    const used = new Map<string, number>()
    const zipFiles: Array<{ name: string; input: Blob }> = []
    let failed = 0

    setProgress({ done: 0, total: items.length })
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        try {
          const image = await decodeImage(item.imgUrl)
          const blob = await engine.exportBlob(image, exportFormat, targetMaxKb)
          const base = `${item.name}-${activeSpec.id}`
          const seen = used.get(base) ?? 0
          used.set(base, seen + 1)
          zipFiles.push({ name: seen ? `${base}-${seen + 1}.${exportFormat}` : `${base}.${exportFormat}`, input: blob })
        } catch {
          failed++
        }
        setProgress({ done: index + 1, total: items.length })
      }

      if (zipFiles.length === 0) {
        useUi.getState().toast({
          title: t('tools.id_photo.batch.failed', { count: failed }),
          tone: 'danger',
        })
        return
      }

      const zipBlob = await downloadZip(zipFiles).blob()
      const url = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `idphotos-batch-${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)

      useUi.getState().toast({
        title: failed
          ? t('tools.id_photo.batch.failed', { count: failed })
          : t('tools.id_photo.batch.export_zip'),
        tone: failed ? 'warning' : 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setProgress(null)
    }
  }

  const processing = progress !== null

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-5xl mx-auto gap-5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
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
          <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            <Plus size={14} className="mr-1" />
            <span>{t('tools.id_photo.batch.upload_btn')}</span>
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={items.length === 0 || processing}
            onClick={() => {
              void handleExportZip()
            }}
          >
            <Download size={14} className="mr-1" />
            <span>
              {progress
                ? t('tools.id_photo.batch.processing', { done: progress.done, total: progress.total })
                : t('tools.id_photo.batch.export_zip')}
            </span>
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addFiles(e.dataTransfer.files)
          }}
          className={cn(
            'relative flex w-full flex-col items-center justify-center gap-3 rounded-[var(--r-lg)] border-2 p-12 text-center cursor-pointer select-none',
            'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            dragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-subtle)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
          )}
        >
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
              {t('tools.id_photo.common.target_spec')}: {activeSpec.flagEmoji}{' '}
              {activeSpec.nameKey ? t(activeSpec.nameKey as never) : activeSpec.name} (
              {activeSpec.widthPx}×{activeSpec.heightPx} {t('tools.id_photo.unit.px')})
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="relative flex flex-col rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 shadow-xs"
              >
                <div className="relative aspect-[3/4] w-full overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-base)]">
                  <img src={item.imgUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                </div>
                <div className="flex items-center justify-between gap-1 pt-1.5">
                  <span className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                    {item.name}
                  </span>
                  <IconButton
                    size="xs"
                    variant="danger"
                    label={`${t('tools.id_photo.common.delete')}: ${item.name}`}
                    onClick={() => removeItem(item.id)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
