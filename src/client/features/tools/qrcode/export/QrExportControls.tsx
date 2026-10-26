import { useState } from 'react'
import { Check, Cloud, Copy, Download } from 'lucide-react'
import type { QrExportFormat } from '../../../../../shared/tools/qrcode/types'
import { copyQrCodeToClipboard, downloadQrCode, exportQrToDataUrl } from '../engine/export-pipeline'
import { QrEngine } from '../engine/qr-engine'
import { useQrCodeStore } from '../store'
import { saveQrRecord } from '../api'
import { Field, Slider } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'

export function QrExportControls() {
  const [downloading, setDownloading] = useState(false)
  const [copying, setCopying] = useState(false)
  const [savingCloud, setSavingCloud] = useState(false)
  const [copied, setCopied] = useState(false)

  const exportSize = useQrCodeStore((s) => s.exportSize)
  const setExportSize = useQrCodeStore((s) => s.setExportSize)
  const getEncodedPayload = useQrCodeStore((s) => s.getEncodedPayload)
  const options = useQrCodeStore((s) => s.options)
  const contentType = useQrCodeStore((s) => s.contentType)

  const payload = getEncodedPayload()
  const hasContent = Boolean(payload.trim())

  const getEngine = () => new QrEngine(options, payload)

  const handleDownload = async (format: QrExportFormat) => {
    if (!hasContent) return
    setDownloading(true)
    try {
      const engine = getEngine()
      await downloadQrCode(engine, {
        format,
        width: exportSize,
        filename: `qrcode-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`,
      })
      useUi.getState().toast({ title: t('tools.qrcode.export.download_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.export.download_error'), tone: 'danger' })
    } finally {
      setDownloading(false)
    }
  }

  const handleCopy = async () => {
    if (!hasContent) return
    setCopying(true)
    try {
      const engine = getEngine()
      const success = await copyQrCodeToClipboard(engine, { width: exportSize })
      if (success) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
        useUi.getState().toast({ title: t('tools.qrcode.export.copy_success'), tone: 'success' })
      } else {
        useUi.getState().toast({ title: t('tools.qrcode.export.copy_error'), tone: 'danger' })
      }
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.export.copy_error'), tone: 'danger' })
    } finally {
      setCopying(false)
    }
  }

  const handleSaveToCloud = async () => {
    if (!hasContent) return
    setSavingCloud(true)
    try {
      const engine = getEngine()
      const dataUrl = await exportQrToDataUrl(engine, { width: exportSize, format: 'png' })
      await saveQrRecord({
        title: `QR-${new Date().toLocaleDateString()}`,
        contentType,
        contentRaw: payload,
        options,
        fileData: dataUrl,
        fileType: 'png',
        width: exportSize,
        height: exportSize,
      })
      useUi.getState().toast({ title: t('tools.qrcode.export.cloud_save_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.export.cloud_save_error'), tone: 'danger' })
    } finally {
      setSavingCloud(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 shadow-sm">
      <div className="relative flex items-center justify-center">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-dashed border-[var(--border-subtle)]" />
        </div>
        <span className="relative bg-[var(--bg-sunken)] px-3 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.export.section_title')}
        </span>
      </div>

      <Field label={`${t('tools.qrcode.export.size_label')}: ${exportSize}px`}>
        <Slider
          value={exportSize}
          min={300}
          max={2000}
          step={100}
          onChange={(val) => setExportSize(val)}
        />
        <div className="flex justify-between text-[length:var(--text-10)] text-[var(--text-tertiary)] px-1 mt-1">
          <span>{'500px'}</span>
          <span>{'1000px'}</span>
          <span>{'1500px'}</span>
        </div>
      </Field>

      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.export.format_label')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          {(['png', 'jpeg', 'svg', 'webp'] as const).map((fmt) => (
            <Button
              key={fmt}
              variant="secondary"
              size="sm"
              disabled={!hasContent || downloading}
              onClick={() => handleDownload(fmt)}
              icon={<Download size={14} />}
            >
              {fmt.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-[var(--border-subtle)]">
        <Button
          variant="secondary"
          size="sm"
          block
          disabled={!hasContent || copying}
          onClick={handleCopy}
          icon={copied ? <Check size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
        >
          {copied ? t('tools.qrcode.export.copied') : t('tools.qrcode.export.copy_image')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          block
          loading={savingCloud}
          disabled={!hasContent || savingCloud}
          onClick={handleSaveToCloud}
          icon={<Cloud size={14} />}
        >
          {t('tools.qrcode.export.save_cloud')}
        </Button>
      </div>
    </div>
  )
}
