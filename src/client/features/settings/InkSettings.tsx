import { Button } from '../../components/primitives'
import { Input, Segmented, SettingRow, Switch } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { ColorWellField } from '../../components/color-field'
import { t } from '../../lib/i18n'
import type { InkPaperStyle } from '../../lib/inkpad/types'
import { useInkSettingsStore } from '../inkpad/ink-settings-store'

const PAPER_OPTIONS: Array<{ value: InkPaperStyle; labelKey: 'settings.ink_paper_grid' | 'settings.ink_paper_dots' | 'settings.ink_paper_lines' | 'settings.ink_paper_cornell' | 'settings.ink_paper_music' | 'settings.ink_paper_weekly' | 'settings.ink_paper_blank' }> = [
    { value: 'grid', labelKey: 'settings.ink_paper_grid' },
    { value: 'dots', labelKey: 'settings.ink_paper_dots' },
    { value: 'lines', labelKey: 'settings.ink_paper_lines' },
    { value: 'cornell', labelKey: 'settings.ink_paper_cornell' },
    { value: 'music', labelKey: 'settings.ink_paper_music' },
    { value: 'weekly', labelKey: 'settings.ink_paper_weekly' },
    { value: 'blank', labelKey: 'settings.ink_paper_blank' },
]

export function InkSettings() {
    const settings = useInkSettingsStore()
    return (
        <div className="space-y-1">
            <div className="pb-2">
                <p className="text-[length:var(--text-12-5)] leading-relaxed text-[var(--text-secondary)]">{t('settings.ink_desc')}</p>
            </div>

            <SettingRow title={t('settings.ink_folder')} description={t('settings.ink_folder_desc')}>
                <Input value={settings.folder} onChange={(event) => settings.updateSettings({ folder: event.target.value })} placeholder="ink" className="w-48 text-xs" />
            </SettingRow>
            <SettingRow title={t('settings.ink_prefix')} description={t('settings.ink_prefix_desc')}>
                <Input value={settings.filenamePrefix} onChange={(event) => settings.updateSettings({ filenamePrefix: event.target.value })} className="w-48 text-xs" />
            </SettingRow>
            <SettingRow title={t('settings.ink_date_format')} description={t('settings.ink_date_format_desc')}>
                <Input value={settings.filenameDateFormat} onChange={(event) => settings.updateSettings({ filenameDateFormat: event.target.value })} className="w-48 text-xs" />
            </SettingRow>
            <SettingRow title={t('settings.ink_extension')} description={t('settings.ink_extension_desc')}>
                <Switch checked={settings.useInkExtension} onChange={(checked) => settings.updateSettings({ useInkExtension: checked })} />
            </SettingRow>
            <SettingRow title={t('settings.ink_autosave')} description={t('settings.ink_autosave_desc')}>
                <Input
                    type="number"
                    min={1000}
                    max={5000}
                    step={100}
                    value={String(settings.autoSaveIntervalMs)}
                    onChange={(event) => {
                        const next = Number(event.target.value)
                        if (!Number.isFinite(next)) return
                        settings.updateSettings({ autoSaveIntervalMs: Math.max(1000, Math.min(5000, next)) })
                    }}
                    className="w-28 text-xs"
                />
            </SettingRow>

            <SettingRow title={t('settings.ink_paper')}>
                <SelectMenu
                    label={t('settings.ink_paper')}
                    value={settings.paperStyle}
                    options={PAPER_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={(value) => settings.updateSettings({ paperStyle: value })}
                />
            </SettingRow>
            <SettingRow title={t('settings.ink_color')}>
                <div className="flex items-center gap-2">
                    <Segmented
                        value={settings.defaultColor === 'auto' ? 'auto' : 'custom'}
                        options={[
                            { value: 'auto', label: t('settings.ink_color_auto') },
                            { value: 'custom', label: t('settings.ink_color_custom') },
                        ]}
                        onChange={(value) => settings.updateSettings({ defaultColor: value === 'auto' ? 'auto' : '#ffffff' })}
                    />
                    <ColorWellField
                        value={settings.defaultColor === 'auto' ? null : settings.defaultColor}
                        label={t('settings.ink_color')}
                        onChange={(value) => settings.updateSettings({ defaultColor: value })}
                    />
                </div>
            </SettingRow>
            <SettingRow title={t('settings.ink_canvas')} description={t('settings.ink_canvas_desc')}>
                <Segmented
                    value={settings.canvasBackground}
                    options={[
                        { value: 'theme', label: t('settings.ink_canvas_theme') },
                        { value: 'dark', label: t('settings.ink_canvas_dark') },
                    ]}
                    onChange={(value) => settings.updateSettings({ canvasBackground: value === 'dark' ? 'dark' : 'theme' })}
                />
            </SettingRow>
            <SettingRow title={t('settings.ink_pressure')} description={t('settings.ink_pressure_desc')}>
                <Segmented
                    value={settings.pressureResponse}
                    options={[
                        { value: 'fixed', label: t('settings.ink_pressure_fixed') },
                        { value: 'subtle', label: t('settings.ink_pressure_subtle') },
                        { value: 'natural', label: t('settings.ink_pressure_natural') },
                    ]}
                    onChange={(value) => settings.updateSettings({ pressureResponse: value === 'fixed' ? 'fixed' : value === 'natural' ? 'natural' : 'subtle' })}
                />
            </SettingRow>
            <SettingRow title={t('settings.ink_adjacent')} description={t('settings.ink_adjacent_desc')}>
                <Switch checked={settings.openInAdjacentPane} onChange={(checked) => settings.updateSettings({ openInAdjacentPane: checked })} />
            </SettingRow>

            <div className="pt-3">
                <Button size="sm" variant="secondary" onClick={settings.resetSettings} className="text-xs text-[var(--text-tertiary)]">
                    {t('settings.ink_reset')}
                </Button>
            </div>
        </div>
    )
}
