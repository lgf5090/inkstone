import { useEffect, useState } from 'react'
import type { QrErrorCorrectionLevel, QrExportFormat } from '../../../../../shared/tools/qrcode/types'
import { fetchQrSettings, updateQrSettings } from '../api'
import { Field, Segmented, Slider, Switch } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { t } from '../../../../lib/i18n'

export function QrSettingsView() {
  const [errorCorrection, setErrorCorrection] = useState<QrErrorCorrectionLevel>('Q')
  const [format, setFormat] = useState<QrExportFormat>('png')
  const [size, setSize] = useState(1000)
  const [autoSave, setAutoSave] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchQrSettings()
      .then((s) => {
        setErrorCorrection(s.defaultErrorCorrection)
        setFormat(s.defaultFormat)
        setSize(s.defaultSize)
        setAutoSave(s.autoSaveHistory)
      })
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateQrSettings({
        defaultErrorCorrection: errorCorrection,
        defaultFormat: format,
        defaultSize: size,
        autoSaveHistory: autoSave,
      })
      useUi.getState().toast({ title: t('tools.qrcode.settings.save_success'), tone: 'success' })
    } catch {
      useUi.getState().toast({ title: t('tools.qrcode.settings.save_error'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full max-w-xl flex-col p-4 overflow-y-auto">
      <div className="mb-6">
        <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {t('tools.qrcode.settings.title')}
        </h2>
        <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('tools.qrcode.settings.subtitle')}
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <Field label={t('tools.qrcode.settings.default_correction')}>
          <Segmented<QrErrorCorrectionLevel>
            value={errorCorrection}
            onChange={setErrorCorrection}
            options={[
              { value: 'L', label: '7% (L)' },
              { value: 'M', label: '15% (M)' },
              { value: 'Q', label: '25% (Q)' },
              { value: 'H', label: '30% (H)' },
            ]}
          />
        </Field>

        <Field label={t('tools.qrcode.settings.default_format')}>
          <Segmented<QrExportFormat>
            value={format}
            onChange={setFormat}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
              { value: 'svg', label: 'SVG' },
              { value: 'webp', label: 'WEBP' },
            ]}
          />
        </Field>

        <Field label={`${t('tools.qrcode.settings.default_size')}: ${size}px`}>
          <Slider value={size} min={300} max={2000} step={100} onChange={setSize} />
        </Field>

        <div className="flex items-center justify-between py-2 border-t border-[var(--border-subtle)]">
          <div className="flex flex-col">
            <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
              {t('tools.qrcode.settings.auto_save')}
            </span>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.qrcode.settings.auto_save_desc')}
            </span>
          </div>
          <Switch checked={autoSave} onChange={setAutoSave} />
        </div>

        <div className="pt-4">
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {t('tools.qrcode.settings.save_button')}
          </Button>
        </div>
      </div>
    </div>
  )
}
