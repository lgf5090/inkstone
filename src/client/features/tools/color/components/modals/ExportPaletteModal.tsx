import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { Field, Select } from '../../../../../components/form'
import { t } from '../../../../../lib/i18n'
import { useUi } from '../../../../../store/ui'
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_IDS,
  exportFileName,
  exportToAseBlob,
  triggerDownload,
  type ExportFormatId,
} from '../../lib/export-engine'
import { useColorStudioStore } from '../../store'

export function ExportPaletteModal() {
  const isOpen = useColorStudioStore((s) => s.isExportPaletteModalOpen)
  const onClose = useColorStudioStore((s) => s.closeExportPaletteModal)
  const targetPalette = useColorStudioStore((s) => s.exportTargetPalette)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [activeFormat, setActiveFormat] = useState<ExportFormatId>('css')
  const [hasCopied, setHasCopied] = useState(false)

  // A closed modal has no work to do: the preview box walks the whole palette and the swatch strip
  // rebuilds, and all five modals used to do that on every step of a hue drag.
  if (!isOpen) return null

  const paletteData = targetPalette || {
    title: t('tools.color.export.default_title'),
    colors: [currentHex, '#3b82f6', '#10b981', '#f59e0b'],
  }

  const format = EXPORT_FORMATS[activeFormat]
  const fileName = exportFileName(activeFormat, paletteData)

  const getCodePreview = (): string =>
    format.binary
      ? t('tools.color.export.binary_notice', { format: t(format.labelKey), count: paletteData.colors.length })
      : format.build(paletteData)

  const handleCopy = async () => {
    if (format.binary) return
    const code = getCodePreview()
    try {
      await navigator.clipboard.writeText(code)
      setHasCopied(true)
      useUi.getState().toast({
        title: t('tools.color.toast.copied', {
          label: t(format.labelKey),
          value: code.slice(0, 30) + '...',
        }),
        tone: 'success',
      })
      setTimeout(() => setHasCopied(false), 2000)
    } catch {
      useUi.getState().toast({
        title: t('tools.color.toast.copy_failed'),
        tone: 'danger',
      })
    }
  }

  const handleDownload = () => {
    const body = format.binary ? exportToAseBlob(paletteData) : format.build(paletteData)
    triggerDownload(body, fileName, format.mime)

    useUi.getState().toast({
      title: t('tools.color.toast.downloaded', { name: fileName }),
      tone: 'success',
    })
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('tools.color.export.title')}
      width={620}
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.color.export.colors_count', {
              title: paletteData.title,
              count: paletteData.colors.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            {!format.binary && (
              <Button size="sm" variant="secondary" onClick={handleCopy}>
                {hasCopied ? (
                  <Check size={14} className="mr-1 text-[var(--success)]" />
                ) : (
                  <Copy size={14} className="mr-1" />
                )}
                {t('tools.color.export.copy_code')}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={handleDownload}>
              <Download size={14} className="mr-1" />
              {t('tools.color.export.download')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Swatches preview strip */}
        <div className="flex h-10 w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] shadow-xs">
          {paletteData.colors.map((hex, i) => (
            <div
              key={i}
              className="flex-1 h-full"
              style={{ backgroundColor: hex }}
              title={hex}
            />
          ))}
        </div>

        {/* Format Selector */}
        <Field label={t('tools.color.export.format_label')}>
          <Select
            id="color-export-format"
            value={activeFormat}
            onChange={(e) => setActiveFormat(e.target.value as ExportFormatId)}
          >
            {EXPORT_FORMAT_IDS.map((id) => (
              <option key={id} value={id}>
                {t(EXPORT_FORMATS[id].labelKey)}
              </option>
            ))}
          </Select>
        </Field>

        {/* Code Preview Box */}
        <div className="relative rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <pre className="max-h-56 overflow-auto font-mono text-[length:var(--text-12)] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
            {getCodePreview()}
          </pre>
        </div>
      </div>
    </Modal>
  )
}
