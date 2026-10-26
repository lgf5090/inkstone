import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { Modal } from '../../../../../components/overlay'
import { Button } from '../../../../../components/primitives'
import { t } from '../../../../../lib/i18n'
import { useUi } from '../../../../../store/ui'
import {
  exportToAseBlob,
  exportToCssVariables,
  exportToJson,
  exportToScssVariables,
  exportToTailwindConfig,
  triggerDownload,
} from '../../lib/export-engine'
import { useColorStudioStore } from '../../store'

type ExportFormat = 'ase' | 'css' | 'scss' | 'tailwind' | 'json'

export function ExportPaletteModal() {
  const isOpen = useColorStudioStore((s) => s.isExportPaletteModalOpen)
  const onClose = useColorStudioStore((s) => s.closeExportPaletteModal)
  const targetPalette = useColorStudioStore((s) => s.exportTargetPalette)
  const currentHex = useColorStudioStore((s) => s.currentHex)

  const [activeFormat, setActiveFormat] = useState<ExportFormat>('css')
  const [hasCopied, setHasCopied] = useState(false)

  const paletteData = targetPalette || {
    title: 'Color Scheme',
    colors: [currentHex, '#3b82f6', '#10b981', '#f59e0b'],
  }

  const getCodePreview = (): string => {
    switch (activeFormat) {
      case 'css':
        return exportToCssVariables(paletteData)
      case 'scss':
        return exportToScssVariables(paletteData)
      case 'tailwind':
        return exportToTailwindConfig(paletteData)
      case 'json':
        return exportToJson(paletteData)
      case 'ase':
        return `// Binary Adobe Swatch Exchange format (.ase)\n// Contains ${paletteData.colors.length} calibrated RGB swatches\n// Click "Download File" to save and load into Adobe Photoshop / Illustrator / InDesign.`
      default:
        return ''
    }
  }

  const handleCopy = async () => {
    if (activeFormat === 'ase') return
    const code = getCodePreview()
    try {
      await navigator.clipboard.writeText(code)
      setHasCopied(true)
      useUi.getState().toast({
        title: t('tools.color.toast.copied', {
          label: activeFormat.toUpperCase(),
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
    const slug = paletteData.title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'palette'
    switch (activeFormat) {
      case 'ase': {
        const blob = exportToAseBlob(paletteData)
        triggerDownload(blob, `${slug}.ase`, 'application/octet-stream')
        break
      }
      case 'css':
        triggerDownload(exportToCssVariables(paletteData), `${slug}.css`, 'text/css')
        break
      case 'scss':
        triggerDownload(exportToScssVariables(paletteData), `${slug}.scss`, 'text/x-scss')
        break
      case 'tailwind':
        triggerDownload(exportToTailwindConfig(paletteData), `tailwind.config.js`, 'text/javascript')
        break
      case 'json':
        triggerDownload(exportToJson(paletteData), `${slug}.json`, 'application/json')
        break
    }

    useUi.getState().toast({
      title: t('tools.color.toast.copied', {
        label: 'File Downloaded',
        value: `${slug}.${activeFormat}`,
      }),
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
            {activeFormat !== 'ase' && (
              <Button size="sm" variant="secondary" onClick={handleCopy}>
                {hasCopied ? (
                  <Check size={14} className="mr-1 text-[var(--color-success-500)]" />
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

        {/* Format Selector Tabs */}
        <div className="flex flex-wrap gap-1 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-1">
          {(
            [
              { key: 'css', label: t('tools.color.export.format_css') },
              { key: 'scss', label: t('tools.color.export.format_scss') },
              { key: 'tailwind', label: t('tools.color.export.format_tailwind') },
              { key: 'ase', label: t('tools.color.export.format_ase') },
              { key: 'json', label: t('tools.color.export.format_json') },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveFormat(item.key)}
              className={`flex-1 min-w-[70px] rounded-[var(--radius-sm)] py-1.5 px-2 text-center text-[length:var(--text-12)] font-medium transition-colors ${
                activeFormat === item.key
                  ? 'bg-[var(--bg-surface)] text-[var(--brand-primary)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

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
