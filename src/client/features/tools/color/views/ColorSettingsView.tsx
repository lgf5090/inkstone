import { useEffect, useState } from 'react'
import type { ColorSettings } from '@shared/tools/color/types'
import { Select, SettingRow, Switch } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'

const FORMAT_OPTIONS: Array<ColorSettings['defaultFormat']> = ['hex', 'rgb', 'hsl', 'cmyk', 'lab']

/** The tabs `UiPaletteView` can open on; a stored value outside this list falls back to the first. */
const UI_TAB_OPTIONS = ['tailwind', 'antd', 'fluent', 'flat', 'open_color', 'material'] as const

export function ColorSettingsView() {
  const settings = useColorStudioStore((s) => s.settings)
  const updateSettings = useColorStudioStore((s) => s.updateSettings)

  const [draft, setDraft] = useState(settings)

  // The server answers the settings fetch after mount, so the form follows it until the reader touches a
  // control; from then on their edits win, otherwise a slow response would overwrite what they just set.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setDraft(settings)
  }, [settings, touched])

  const change = <K extends keyof ColorSettings>(key: K, value: ColorSettings[K]) => {
    setTouched(true)
    setDraft((current) => ({ ...current, [key]: value }))
    void updateSettings({ [key]: value } as Partial<ColorSettings>)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6 bg-[var(--bg-base)]">
      <div className="w-full max-w-2xl mx-auto">
        <h2 className="text-[length:var(--text-18)] font-bold text-[var(--text-primary)]">
          {t('tools.color.settings.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-13)] text-[var(--text-secondary)]">
          {t('tools.color.settings.subtitle')}
        </p>

        <div className="mt-6 flex flex-col">
          <SettingRow
            title={t('tools.color.settings.default_format')}
            description={t('tools.color.settings.default_format_desc')}
            controlId="color-default-format"
          >
            <Select
              id="color-default-format"
              value={draft.defaultFormat}
              onChange={(e) => change('defaultFormat', e.target.value as ColorSettings['defaultFormat'])}
            >
              {FORMAT_OPTIONS.map((format) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </Select>
          </SettingRow>

          <SettingRow
            title={t('tools.color.settings.strip_hash')}
            description={t('tools.color.settings.strip_hash_desc')}
            controlId="color-strip-hash"
          >
            <Switch
              id="color-strip-hash"
              checked={draft.stripHash}
              onChange={(next) => change('stripHash', next)}
              label={t('tools.color.settings.strip_hash')}
            />
          </SettingRow>

          <SettingRow
            title={t('tools.color.settings.auto_save')}
            description={t('tools.color.settings.auto_save_desc')}
            controlId="color-auto-save"
          >
            <Switch
              id="color-auto-save"
              checked={draft.autoSaveHistory}
              onChange={(next) => change('autoSaveHistory', next)}
              label={t('tools.color.settings.auto_save')}
            />
          </SettingRow>

          <SettingRow
            title={t('tools.color.settings.default_tab')}
            description={t('tools.color.settings.default_tab_desc')}
            controlId="color-default-tab"
          >
            <Select
              id="color-default-tab"
              value={UI_TAB_OPTIONS.includes(draft.defaultUiTab as (typeof UI_TAB_OPTIONS)[number]) ? draft.defaultUiTab : 'tailwind'}
              onChange={(e) => change('defaultUiTab', e.target.value)}
            >
              {UI_TAB_OPTIONS.map((tab) => (
                <option key={tab} value={tab}>
                  {t(`tools.color.ui.tab.${tab}`)}
                </option>
              ))}
            </Select>
          </SettingRow>
        </div>
      </div>
    </div>
  )
}
