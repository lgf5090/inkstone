import { useEffect, useState } from 'react'
import { Settings } from 'lucide-react'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import { ID_PHOTO_BG_PRESETS } from '@shared/tools/id-photo/presets'
import { t } from '../../../../lib/i18n'
import { Field, Switch } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { getIdPhotoSettings, updateIdPhotoSettings } from '../api'

export function IdPhotoSettingsView() {
  const [defaultSpecId, setDefaultSpecId] = useState('cn_one_inch')
  const [defaultBgColor, setDefaultBgColor] = useState('#ffffff')
  const [defaultExportFormat, setDefaultExportFormat] = useState('jpg')
  const [autoSaveHistory, setAutoSaveHistory] = useState(true)
  const [autoFaceAlign, setAutoFaceAlign] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getIdPhotoSettings().then((s) => {
      setDefaultSpecId(s.defaultSpecId)
      setDefaultBgColor(s.defaultBgColor)
      setDefaultExportFormat(s.defaultExportFormat)
      setAutoSaveHistory(s.autoSaveHistory)
      setAutoFaceAlign(s.autoFaceAlign)
    }).catch(() => {
      // fallback
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateIdPhotoSettings({
        defaultSpecId,
        defaultBgColor,
        defaultExportFormat: defaultExportFormat as any,
        autoSaveHistory,
        autoFaceAlign,
      })
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-2xl mx-auto gap-6">
      {/* Header */}
      <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Settings size={22} />
        </div>
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
            {t('tools.id_photo.settings.title')}
          </h2>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {/* Default Spec */}
        <Field label={t('tools.id_photo.settings.default_spec')}>
          <select
            value={defaultSpecId}
            onChange={(e) => setDefaultSpecId(e.target.value)}
            className="h-9 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 text-[length:var(--text-13)] text-[var(--text-primary)]"
          >
            {BUILTIN_ID_PHOTO_SPECS.map((s) => (
              <option key={s.id} value={s.id}>
                {`${s.flagEmoji ? s.flagEmoji + ' ' : ''}${s.name} (${s.widthMm}×${s.heightMm}mm)`}
              </option>
            ))}
          </select>
        </Field>

        {/* Default Background */}
        <Field label={t('tools.id_photo.settings.default_bg')}>
          <div className="flex items-center gap-2">
            {ID_PHOTO_BG_PRESETS.slice(0, 6).map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setDefaultBgColor(preset.color)}
                style={{ backgroundColor: preset.color }}
                className={`h-7 w-7 rounded-full border-2 transition-transform ${
                  defaultBgColor.toLowerCase() === preset.color.toLowerCase()
                    ? 'border-[var(--accent)] scale-110 shadow-xs'
                    : 'border-black/10 dark:border-white/20'
                }`}
              />
            ))}
          </div>
        </Field>

        {/* Toggles */}
        <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5">
          <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.id_photo.settings.auto_save')}
          </span>
          <Switch
            checked={autoSaveHistory}
            onChange={setAutoSaveHistory}
          />
        </div>

        <div className="flex items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3.5">
          <span className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.id_photo.settings.auto_align')}
          </span>
          <Switch
            checked={autoFaceAlign}
            onChange={setAutoFaceAlign}
          />
        </div>

        <div className="pt-2">
          <Button
            variant="primary"
            disabled={saving}
            onClick={handleSave}
            className="w-full"
          >
            {t('tools.id_photo.settings.save_btn')}
          </Button>
        </div>
      </div>
    </div>
  )
}
