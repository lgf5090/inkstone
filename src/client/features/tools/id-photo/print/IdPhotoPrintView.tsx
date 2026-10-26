import { useEffect, useRef, useState } from 'react'
import { Download, LayoutGrid, Printer } from 'lucide-react'
import { PRINT_SHEET_PRESETS } from '@shared/tools/id-photo/presets'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Field, Slider, Switch } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useIdPhotoStore } from '../store'
import { IdPhotoEngine } from '../engine/id-photo-engine'
import { calculatePrintLayout, renderPrintSheet } from '../engine/print-layout-engine'

export function IdPhotoPrintView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  const imageElement = useIdPhotoStore((s) => s.imageElement)
  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const printOptions = useIdPhotoStore((s) => s.printOptions)
  const setPrintOptions = useIdPhotoStore((s) => s.setPrintOptions)

  const activeSpec = getActiveSpec()

  const layout = calculatePrintLayout(activeSpec.widthMm, activeSpec.heightMm, printOptions)

  useEffect(() => {
    if (!imageElement || !containerRef.current) return

    const engine = new IdPhotoEngine(activeSpec, adjustOptions)
    let isMounted = true

    engine.renderCanvas(imageElement).then((photoCanvas) => {
      if (!isMounted || !containerRef.current) return

      const sheetCanvas = renderPrintSheet(
        photoCanvas,
        printOptions,
        activeSpec.widthMm,
        activeSpec.heightMm,
      )

      containerRef.current.innerHTML = ''
      sheetCanvas.style.maxWidth = '100%'
      sheetCanvas.style.maxHeight = '420px'
      sheetCanvas.style.height = 'auto'
      sheetCanvas.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.12)'
      sheetCanvas.style.borderRadius = 'var(--r-sm)'
      containerRef.current.appendChild(sheetCanvas)
    })

    return () => {
      isMounted = false
    }
  }, [imageElement, activeSpec, adjustOptions, printOptions])

  const handleDownloadSheet = async () => {
    if (!imageElement) return
    setExporting(true)
    try {
      const engine = new IdPhotoEngine(activeSpec, adjustOptions)
      const photoCanvas = await engine.renderCanvas(imageElement)
      const sheetCanvas = renderPrintSheet(
        photoCanvas,
        printOptions,
        activeSpec.widthMm,
        activeSpec.heightMm,
      )

      const dataUrl = sheetCanvas.toDataURL('image/jpeg', 0.95)
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `print-sheet-${printOptions.paperSize}-${Date.now()}.jpg`
      a.click()

      useUi.getState().toast({
        title: t('tools.id_photo.print.download_btn'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      {/* Left Settings Panel */}
      <div className="flex w-full lg:w-[380px] xl:w-[420px] shrink-0 flex-col gap-4 p-4 lg:p-6 overflow-y-auto border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]/20">
        <div className="flex items-center gap-2 pb-2 border-b border-[var(--border-subtle)]">
          <Printer size={18} className="text-[var(--accent)]" />
          <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.id_photo.print.title')}
          </h3>
        </div>

        {/* Paper Size Selector */}
        <div className="flex flex-col gap-2">
          <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.print.paper_select')}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {PRINT_SHEET_PRESETS.map((p) => {
              const isSelected = printOptions.paperSize === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPrintOptions({ paperSize: p.id as any })}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 rounded-[var(--r-md)] border p-2.5 text-center',
                    'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                      : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                    {t(p.nameKey as any)}
                  </span>
                  <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)] font-mono">
                    {p.widthMm}×{p.heightMm}{t('tools.id_photo.unit.mm')}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Orientation */}
        <div className="flex flex-col gap-2">
          <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.print.orientation_label')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPrintOptions({ orientation: 'portrait' })}
              className={cn(
                'flex-1 rounded-[var(--r-md)] border py-1.5 text-[length:var(--text-12)] font-medium',
                printOptions.orientation === 'portrait'
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)]',
              )}
            >
              {t('tools.id_photo.print.orientation_portrait')}
            </button>
            <button
              type="button"
              onClick={() => setPrintOptions({ orientation: 'landscape' })}
              className={cn(
                'flex-1 rounded-[var(--r-md)] border py-1.5 text-[length:var(--text-12)] font-medium',
                printOptions.orientation === 'landscape'
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)]',
              )}
            >
              {t('tools.id_photo.print.orientation_landscape')}
            </button>
          </div>
        </div>

        {/* Guides switch */}
        <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.print.crop_marks')}
          </span>
          <Switch
            checked={printOptions.showCropMarks}
            onChange={(checked: boolean) => setPrintOptions({ showCropMarks: checked })}
          />
        </div>

        {/* Spacing & Margin Sliders */}
        <Field label={t('tools.id_photo.print.gap_label')}>
          <div className="flex items-center gap-3 pt-1">
            <Slider
              min={0}
              max={8}
              step={1}
              value={printOptions.gapMm}
              onChange={(val) => setPrintOptions({ gapMm: val })}
              className="flex-1"
            />
            <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {printOptions.gapMm}{t('tools.id_photo.unit.mm')}
            </span>
          </div>
        </Field>

        <Field label={t('tools.id_photo.print.margin_label')}>
          <div className="flex items-center gap-3 pt-1">
            <Slider
              min={2}
              max={15}
              step={1}
              value={printOptions.marginMm}
              onChange={(val) => setPrintOptions({ marginMm: val })}
              className="flex-1"
            />
            <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {printOptions.marginMm}{t('tools.id_photo.unit.mm')}
            </span>
          </div>
        </Field>

        {/* Download Button */}
        <div className="pt-2">
          <Button
            variant="primary"
            disabled={!imageElement || exporting}
            onClick={handleDownloadSheet}
            className="w-full"
          >
            <Download size={15} className="mr-1.5" />
            <span>{t('tools.id_photo.print.download_btn')}</span>
          </Button>
        </div>
      </div>

      {/* Right Print Preview Canvas */}
      <div className="flex flex-1 flex-col items-center justify-center p-6 bg-[var(--bg-base)] min-h-[420px]">
        {!imageElement ? (
          <div className="flex flex-col items-center justify-center gap-2 text-center text-[var(--text-tertiary)]">
            <LayoutGrid size={36} />
            <p className="text-[length:var(--text-13)]">
              {t('tools.id_photo.preview.empty_desc')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div ref={containerRef} className="flex items-center justify-center" />
            <div className="flex items-center gap-2 rounded-full bg-[var(--bg-sunken)] px-3 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
              <span>{layout.rows} × {layout.cols}</span>
              <span>•</span>
              <span className="font-semibold text-[var(--accent)]">
                {t('tools.id_photo.print.preview_summary', { count: layout.totalCount })}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
