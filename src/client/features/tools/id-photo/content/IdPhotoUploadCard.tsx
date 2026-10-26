import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  RotateCcw,
  RotateCw,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import exifr from 'exifr'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { useIdPhotoStore } from '../store'

export function IdPhotoUploadCard() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const setImageSrc = useIdPhotoStore((s) => s.setImageSrc)
  const rotateImage = useIdPhotoStore((s) => s.rotateImage)
  const resetAdjustOptions = useIdPhotoStore((s) => s.resetAdjustOptions)
  const rotation = useIdPhotoStore((s) => s.adjustOptions.rotation ?? 0)

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return

    try {
      // Auto-orient based on EXIF tag
      let orientation = 1
      try {
        const exifData = await exifr.parse(file, ['Orientation'])
        if (exifData?.Orientation) {
          orientation = exifData.Orientation
        }
      } catch {
        // EXIF read error fallback
      }

      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        if (dataUrl) {
          setImageSrc(dataUrl)
          resetAdjustOptions()
          // Adjust initial rotation if orientation was EXIF 6 or 8
          if (orientation === 6) rotateImage(90)
          else if (orientation === 8) rotateImage(-90)
          else if (orientation === 3) rotateImage(180)
        }
      }
      reader.readAsDataURL(file)
    } catch {
      // Fallback direct read
      const reader = new FileReader()
      reader.onload = (e) => {
        if (e.target?.result) setImageSrc(e.target.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  // Paste listener for Ctrl+V
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) handleFile(file)
          break
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <section
      aria-label={t('tools.id_photo.content.accordion_title')}
      className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5 shadow-sm"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/jpg"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
          e.target.value = ''
        }}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Camera size={18} className="text-[var(--accent)]" />
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.id_photo.content.accordion_title')}
          </h3>
        </div>

        {imageSrc && (
          <div className="flex items-center gap-1">
            <Tooltip label={t('tools.id_photo.content.rotate_left')}>
              <IconButton
                size="sm"
                label={t('tools.id_photo.content.rotate_left')}
                onClick={() => rotateImage(-90)}
              >
                <RotateCcw size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.id_photo.content.rotate_right')}>
              <IconButton
                size="sm"
                label={t('tools.id_photo.content.rotate_right')}
                onClick={() => rotateImage(90)}
              >
                <RotateCw size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.id_photo.content.reupload')}>
              <IconButton
                size="sm"
                label={t('tools.id_photo.content.reupload')}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadCloud size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip label={t('tools.id_photo.content.crop_reset')}>
              <IconButton
                size="sm"
                variant="danger"
                label={t('tools.id_photo.content.crop_reset')}
                onClick={() => setImageSrc(null)}
              >
                <Trash2 size={15} />
              </IconButton>
            </Tooltip>
          </div>
        )}
      </div>

      {!imageSrc ? (
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              fileInputRef.current?.click()
            }
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-2.5 rounded-[var(--r-md)] border-2 border-dashed p-6 text-center cursor-pointer select-none',
            'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            isDragging
              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[var(--border-subtle)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--accent)]">
            <UploadCloud size={22} />
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.content.upload_photo')}
            </p>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.content.upload_drag_hint')}
            </p>
            <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.content.paste_hint')}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-sunken)] text-[var(--accent)] overflow-hidden">
              <img src={imageSrc} alt={t('tools.id_photo.common.thumbnail')} className="h-full w-full object-cover" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                {t('tools.id_photo.content.upload_photo')}
              </span>
              <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {rotation !== 0 ? `Rotation: ${rotation}°` : 'Ready'}
              </span>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            {t('tools.id_photo.content.reupload')}
          </Button>
        </div>
      )}
    </section>
  )
}
