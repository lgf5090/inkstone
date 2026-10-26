import { useState } from 'react'
import { Check, Cloud, Copy, Download, Printer } from 'lucide-react'
import type { IdPhotoExportFormat } from '@shared/tools/id-photo/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Input } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useIdPhotoStore } from '../store'
import { IdPhotoEngine } from '../engine/id-photo-engine'
import { renderPrintSheet } from '../engine/print-layout-engine'
import { createIdPhotoRecord } from '../api'

export function IdPhotoExportControls() {
  const [downloading, setDownloading] = useState(false)
  const [downloadingPrint, setDownloadingPrint] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savingCloud, setSavingCloud] = useState(false)

  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const printOptions = useIdPhotoStore((s) => s.printOptions)
  const exportFormat = useIdPhotoStore((s) => s.exportFormat)
  const setExportFormat = useIdPhotoStore((s) => s.setExportFormat)
  const targetMaxKb = useIdPhotoStore((s) => s.targetMaxKb)
  const setTargetMaxKb = useIdPhotoStore((s) => s.setTargetMaxKb)

  const activeSpec = getActiveSpec()
  const hasImage = Boolean(imageElement)

  const getEngine = () => new IdPhotoEngine(activeSpec, adjustOptions)

  const handleDownloadSingle = async () => {
    if (!imageElement) return
    setDownloading(true)
    try {
      const engine = getEngine()
      const dataUrl = await engine.exportDataUrl(imageElement, exportFormat, targetMaxKb)
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `idphoto-${activeSpec.id}-${Date.now()}.${exportFormat === 'jpeg' ? 'jpg' : exportFormat}`
      a.click()
      useUi.getState().toast({
        title: t('tools.id_photo.export.download_photo'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setDownloading(false)
    }
  }

  const handleDownloadPrint = async () => {
    if (!imageElement) return
    setDownloadingPrint(true)
    try {
      const engine = getEngine()
      const photoCanvas = await engine.renderCanvas(imageElement)
      const printCanvas = renderPrintSheet(
        photoCanvas,
        printOptions,
        activeSpec.widthMm,
        activeSpec.heightMm,
      )
      const mime =
        exportFormat === 'png' ? 'image/png' : exportFormat === 'webp' ? 'image/webp' : 'image/jpeg'
      const dataUrl = printCanvas.toDataURL(mime, 0.95)

      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `idphoto-${activeSpec.id}-print-${Date.now()}.${exportFormat === 'jpeg' ? 'jpg' : exportFormat}`
      a.click()
      useUi.getState().toast({
        title: t('tools.id_photo.export.download_print'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setDownloadingPrint(false)
    }
  }

  const handleCopy = async () => {
    if (!imageElement) return
    setCopying(true)
    try {
      const engine = getEngine()
      const success = await engine.copyToClipboard(imageElement)
      if (success) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        useUi.getState().toast({
          title: t('tools.id_photo.export.copy_success'),
          tone: 'success',
        })
      } else {
        useUi.getState().toast({
          title: t('tools.id_photo.export.copy_error'),
          tone: 'danger',
        })
      }
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.copy_error'),
        tone: 'danger',
      })
    } finally {
      setCopying(false)
    }
  }

  const handleSaveToCloud = async () => {
    if (!imageElement) return
    setSavingCloud(true)
    try {
      const engine = getEngine()
      const photoDataUrl = await engine.exportDataUrl(imageElement, exportFormat, targetMaxKb)
      const photoCanvas = await engine.renderCanvas(imageElement)
      const printCanvas = renderPrintSheet(
        photoCanvas,
        printOptions,
        activeSpec.widthMm,
        activeSpec.heightMm,
      )
      const printDataUrl = printCanvas.toDataURL('image/jpeg', 0.92)

      await createIdPhotoRecord({
        title: `${activeSpec.name} - ${new Date().toLocaleDateString()}`,
        specId: activeSpec.id,
        specName: activeSpec.name,
        widthPx: activeSpec.widthPx,
        heightPx: activeSpec.heightPx,
        widthMm: activeSpec.widthMm,
        heightMm: activeSpec.heightMm,
        dpi: activeSpec.dpi,
        bgColor: adjustOptions.bgColor,
        options: adjustOptions as unknown as Record<string, unknown>,
        fileData: photoDataUrl,
        printFileData: printDataUrl,
        fileType: exportFormat,
      })

      useUi.getState().toast({
        title: t('tools.id_photo.export.save_success'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setSavingCloud(false)
    }
  }

  const formats: IdPhotoExportFormat[] = ['jpg', 'png', 'webp']

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 shadow-sm">
      <div className="relative flex items-center justify-center">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-dashed border-[var(--border-subtle)]" />
        </div>
        <span className="relative bg-[var(--bg-sunken)] px-3 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.id_photo.export.title')}
        </span>
      </div>

      {/* Target Max KB input and Format Selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
        <div className="flex flex-col gap-1">
          <label className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.export.target_size_label')}
          </label>
          <Input
            type="number"
            min={10}
            max={5000}
            value={targetMaxKb ?? ''}
            onChange={(e) => {
              const val = e.target.value ? parseInt(e.target.value, 10) : undefined
              setTargetMaxKb(val)
            }}
            placeholder={t('tools.id_photo.export.target_size_placeholder')}
            aria-label={t('tools.id_photo.export.target_size_label')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.export.format_label')}
          </label>
          <div className="flex items-center gap-1">
            {formats.map((fmt) => {
              const isSelected = exportFormat === fmt
              return (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setExportFormat(fmt)}
                  className={cn(
                    'flex-1 rounded-[var(--r-md)] border py-1.5 text-[length:var(--text-12)] font-semibold uppercase',
                    'transition-[border-color,background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {fmt}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Main Action Buttons */}
      <div className="flex flex-col gap-2 pt-2">
        <Button
          variant="primary"
          disabled={!hasImage || downloading}
          onClick={handleDownloadSingle}
          className="w-full"
        >
          <Download size={15} className="mr-1.5" />
          <span>{t('tools.id_photo.export.download_photo')}</span>
        </Button>

        <Button
          variant="secondary"
          disabled={!hasImage || downloadingPrint}
          onClick={handleDownloadPrint}
          className="w-full"
        >
          <Printer size={15} className="mr-1.5" />
          <span>{t('tools.id_photo.export.download_print')}</span>
        </Button>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button
            variant="ghost"
            disabled={!hasImage || copying}
            onClick={handleCopy}
            className="w-full"
          >
            {copied ? <Check size={14} className="mr-1" /> : <Copy size={14} className="mr-1" />}
            <span>{copied ? 'Copied!' : t('tools.id_photo.export.copy_photo')}</span>
          </Button>

          <Button
            variant="ghost"
            disabled={!hasImage || savingCloud}
            onClick={handleSaveToCloud}
            className="w-full"
          >
            <Cloud size={14} className="mr-1 text-[var(--accent)]" />
            <span>{t('tools.id_photo.export.save_cloud')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
