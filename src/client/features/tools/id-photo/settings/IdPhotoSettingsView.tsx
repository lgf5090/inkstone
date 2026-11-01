import { useEffect, useState } from 'react'
import { RotateCcw, Settings } from 'lucide-react'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import { ID_PHOTO_BG_PRESETS, PRINT_SHEET_PRESETS } from '@shared/tools/id-photo/presets'
import type { IdPhotoExportFormat, PrintSheetOptions } from '@shared/tools/id-photo/types'
import { t } from '../../../../lib/i18n'
import { SelectMenu } from '../../../../components/select-menu'
import { Field } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { getIdPhotoSettings, updateIdPhotoSettings } from '../api'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'

const EXPORT_FORMATS: readonly IdPhotoExportFormat[] = ['jpg', 'png', 'webp']

export function IdPhotoSettingsView() {
  const [defaultSpecId, setDefaultSpecId] = useState('cn_one_inch')
  const [defaultBgColor, setDefaultBgColor] = useState('#ffffff')
  const [defaultExportFormat, setDefaultExportFormat] = useState<IdPhotoExportFormat>('jpg')
  const [printPaperSize, setPrintPaperSize] = useState<PrintSheetOptions['paperSize']>('6inch')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)

  const customSpecs = useIdPhotoStore((s) => s.customSpecs)
  const applyUserSettings = useIdPhotoStore((s) => s.applyUserSettings)

  const load = () => {
    setLoading(true)
    setLoadFailed(false)
    getIdPhotoSettings()
      .then((settings) => {
        setDefaultSpecId(settings.defaultSpecId)
        setDefaultBgColor(settings.defaultBgColor)
        setDefaultExportFormat(settings.defaultExportFormat as IdPhotoExportFormat)
        setPrintPaperSize(settings.printPaperSize)
      })
      .catch(() => {
        setLoadFailed(true)
      })
      .finally(() => {
        setLoading(false)
      })
  }

  useEffect(load, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateIdPhotoSettings({
        defaultSpecId,
        defaultBgColor,
        defaultExportFormat,
        printPaperSize,
      })
      applyUserSettings(updated)
      useUi.getState().toast({
        title: t('tools.id_photo.settings.save_success'),
        tone: 'success',
      })
    } catch {
      useUi.getState().toast({
        title: t('tools.id_photo.export.save_error'),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  const specOptions = [...customSpecs, ...BUILTIN_ID_PHOTO_SPECS].map((spec) => ({
    value: spec.id,
    label: `${spec.flagEmoji ? `${spec.flagEmoji} ` : ''}${specLabel(spec)} (${spec.widthMm}×${spec.heightMm}mm)`,
  }))

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-2xl mx-auto gap-6">
      <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]">
          <Settings size={22} />
        </div>
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.id_photo.settings.title')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.id_photo.settings.hint')}
          </p>
        </div>
      </div>

      {loading && (
        <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">…</p>
      )}

      {!loading && loadFailed && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[length:var(--text-13)] font-medium text-[var(--danger)]">
            {t('tools.id_photo.settings.load_failed')}
          </p>
          <Button variant="secondary" onClick={load}>
            <RotateCcw size={14} className="mr-1.5" />
            <span>{t('tools.id_photo.settings.retry')}</span>
          </Button>
        </div>
      )}

      {!loading && !loadFailed && (
        <div className="flex flex-col gap-4">
          <Field label={t('tools.id_photo.settings.default_spec')}>
            <SelectMenu
              label={t('tools.id_photo.settings.default_spec')}
              value={defaultSpecId}
              options={specOptions}
              onChange={setDefaultSpecId}
              className="w-full"
              width={320}
            />
          </Field>

          <Field label={t('tools.id_photo.settings.default_bg')}>
            <div className="flex flex-wrap items-center gap-2">
              {ID_PHOTO_BG_PRESETS.filter((preset) => !preset.isGradient)
                .slice(0, 7)
                .map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-label={t(preset.nameKey)}
                    aria-pressed={defaultBgColor.toLowerCase() === preset.color.toLowerCase()}
                    onClick={() => setDefaultBgColor(preset.color)}
                    style={{ backgroundColor: preset.color }}
                    className={`h-7 w-7 rounded-full border-2 transition-transform ${
                      defaultBgColor.toLowerCase() === preset.color.toLowerCase()
                        ? 'border-[var(--accent)] scale-110'
                        : 'border-[var(--border-strong)]'
                    }`}
                  />
                ))}
              <span className="font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {defaultBgColor}
              </span>
            </div>
          </Field>

          <Field label={t('tools.id_photo.export.format_label')}>
            <SelectMenu
              label={t('tools.id_photo.export.format_label')}
              value={defaultExportFormat}
              options={EXPORT_FORMATS.map((format) => ({ value: format, label: format.toUpperCase() }))}
              onChange={(value) => setDefaultExportFormat(value)}
              className="w-full"
              width={160}
            />
          </Field>

          <Field label={t('tools.id_photo.print.paper_select')}>
            <SelectMenu
              label={t('tools.id_photo.print.paper_select')}
              value={printPaperSize}
              options={PRINT_SHEET_PRESETS.map((preset) => ({
                value: preset.id,
                label: `${t(preset.nameKey)} (${preset.widthMm}×${preset.heightMm}mm)`,
              }))}
              onChange={(value) => setPrintPaperSize(value)}
              className="w-full"
              width={260}
            />
          </Field>

          <div className="pt-2">
            <Button variant="primary" disabled={saving} onClick={handleSave} className="w-full">
              {t('tools.id_photo.settings.save_btn')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
