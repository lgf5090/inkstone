import { Button } from '../../components/primitives';
import { Input, Segmented, SettingRow, Switch } from '../../components/form';
import { t } from '../../lib/i18n';
import { useMindmapSettingsStore } from '../mindmap/mindmap-settings-store';
import type { MindmapDocumentDirection } from '../../lib/markdown/mindmap/document';

const DIRECTION_CHOICES: { value: string; labelKey: 'mindmap.direction_side' | 'mindmap.direction_right' | 'mindmap.direction_left' | 'mindmap.direction_down' }[] = [
  { value: '2', labelKey: 'mindmap.direction_side' },
  { value: '1', labelKey: 'mindmap.direction_right' },
  { value: '0', labelKey: 'mindmap.direction_left' },
  { value: '3', labelKey: 'mindmap.direction_down' },
];

export function MindmapSettings() {
  const settings = useMindmapSettingsStore();
  const { updateSettings, resetSettings } = settings;

  return (
    <div className="space-y-1">
      <div className="pb-2">
        <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">{t('settings.mindmap_desc')}</p>
      </div>

      <SettingRow title={t('settings.mindmap_folder')} description={t('settings.mindmap_folder_desc')}>
        <Input
          value={settings.folder}
          onChange={(e) => updateSettings({ folder: e.target.value })}
          placeholder="mindmaps"
          className="w-48 text-xs"
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_template')} description={t('settings.mindmap_template_desc')}>
        <Input
          value={settings.templateFilePath}
          onChange={(e) => updateSettings({ templateFilePath: e.target.value })}
          placeholder="mindmap-template.elixir"
          className="w-48 text-xs"
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_prefix')} description={t('settings.mindmap_prefix_desc')}>
        <Input
          value={settings.filenamePrefix}
          onChange={(e) => updateSettings({ filenamePrefix: e.target.value })}
          className="w-48 text-xs"
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_date_format')} description={t('settings.mindmap_date_format_desc')}>
        <Input
          value={settings.filenameDateFormat}
          onChange={(e) => updateSettings({ filenameDateFormat: e.target.value })}
          className="w-48 text-xs"
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_extension')} description={t('settings.mindmap_extension_desc')}>
        <Switch checked={settings.useElixirExtension} onChange={(checked) => updateSettings({ useElixirExtension: checked })} />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_autosave')} description={t('settings.mindmap_autosave_desc')}>
        <Input
          type="number"
          min={100}
          step={100}
          value={String(settings.autoSaveIntervalMs)}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next))
              updateSettings({ autoSaveIntervalMs: Math.max(100, Math.min(10_000, next)) });
          }}
          className="w-28 text-xs"
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_direction')} description={t('settings.mindmap_direction_desc')}>
        <Segmented
          value={String(settings.defaultDirection)}
          options={DIRECTION_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }))}
          onChange={(value) => updateSettings({ defaultDirection: Number(value) as MindmapDocumentDirection })}
        />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_compact')} description={t('settings.mindmap_compact_desc')}>
        <Switch checked={settings.compact} onChange={(checked) => updateSettings({ compact: checked })} />
      </SettingRow>

      <SettingRow title={t('settings.mindmap_adjacent')} description={t('settings.mindmap_adjacent_desc')}>
        <Switch checked={settings.openInAdjacentPane} onChange={(checked) => updateSettings({ openInAdjacentPane: checked })} />
      </SettingRow>

      <div className="pt-3">
        <Button size="sm" variant="secondary" onClick={resetSettings} className="text-xs text-[var(--text-tertiary)]">
          {t('settings.mindmap_reset_defaults')}
        </Button>
      </div>
    </div>
  );
}
