import { useRef, useState } from 'react';
import {
  Check,
  Cpu,
  Edit2,
  FileBox,
  FileText,
  Folder,
  Hash,
  Layout,
  Link2,
  PenTool,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Type,
  Zap,
} from 'lucide-react';
import { Button, IconButton } from '../../components/primitives';
import { Input, Segmented, SettingRow, Slider, Switch } from '../../components/form';
import { t } from '../../lib/i18n';
import { useExcalidrawSettings } from '../excalidraw/excalidraw-settings-store';
import type { AIProvider, AIProviderConfig } from '../../lib/ai/types';
import type { MessageKey } from '../../lib/i18n';

const PROVIDER_INFO: Record<string, { name: string; typeDescKey: MessageKey; defaultBaseURL: string }> = {
  deepseek: {
    name: 'DeepSeek',
    typeDescKey: 'settings.excalidraw_provider_openai_compat',
    defaultBaseURL: 'https://api.deepseek.com',
  },
  openai: {
    name: 'OpenAI',
    typeDescKey: 'settings.excalidraw_provider_openai',
    defaultBaseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    name: 'Anthropic',
    typeDescKey: 'settings.excalidraw_provider_anthropic',
    defaultBaseURL: 'https://api.anthropic.com/v1',
  },
  google: {
    name: 'Google Gemini',
    typeDescKey: 'settings.excalidraw_provider_gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
  },
  xai: {
    name: 'xAI',
    typeDescKey: 'settings.excalidraw_provider_xai',
    defaultBaseURL: 'https://api.x.ai/v1',
  },
};

type CategoryId =
  | 'all'
  | 'basic'
  | 'saving'
  | 'ai'
  | 'ui'
  | 'links'
  | 'embed_md'
  | 'embed_files'
  | 'extended'
  | 'fonts'
  | 'misc'
  | 'automate'
  | 'compatibility';

interface CategoryTab {
  id: CategoryId;
  labelKey: MessageKey;
}

const CATEGORY_TABS: CategoryTab[] = [
  { id: 'all', labelKey: 'settings.excalidraw_cat_all' },
  { id: 'basic', labelKey: 'settings.excalidraw_cat_basic' },
  { id: 'saving', labelKey: 'settings.excalidraw_cat_saving' },
  { id: 'ai', labelKey: 'settings.excalidraw_cat_ai' },
  { id: 'ui', labelKey: 'settings.excalidraw_cat_ui' },
  { id: 'links', labelKey: 'settings.excalidraw_cat_links' },
  { id: 'embed_md', labelKey: 'settings.excalidraw_cat_embed_md' },
  { id: 'embed_files', labelKey: 'settings.excalidraw_cat_embed_files' },
  { id: 'extended', labelKey: 'settings.excalidraw_cat_extended' },
  { id: 'fonts', labelKey: 'settings.excalidraw_cat_fonts' },
  { id: 'misc', labelKey: 'settings.excalidraw_cat_misc' },
  { id: 'automate', labelKey: 'settings.excalidraw_cat_automate' },
  { id: 'compatibility', labelKey: 'settings.excalidraw_cat_compatibility' },
];

export function ExcalidrawSettings() {
  const settings = useExcalidrawSettings();
  const update = settings.updateSettings;

  const [activeCategory, setActiveCategory] = useState<CategoryId>('all');
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    loading: boolean;
    ok?: boolean;
    latencyMs?: number;
    error?: string;
  }>({ loading: false });

  const containerRef = useRef<HTMLDivElement>(null);

  const handleTestConnection = async () => {
    setTestResult({ loading: true });
    try {
      const res = await settings.testActiveConnection();
      setTestResult({
        loading: false,
        ok: res.ok,
        latencyMs: res.latencyMs,
        error: res.error,
      });
    } catch (err: unknown) {
      setTestResult({
        loading: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleProviderConfigChange = (
    providerId: string,
    field: keyof AIProviderConfig,
    value: string,
  ) => {
    const prev = settings.aiProviders[providerId] || {
      provider: 'openai-compatible' as AIProvider,
      baseURL: PROVIDER_INFO[providerId]?.defaultBaseURL || '',
      apiKey: '',
    };
    update({
      aiProviders: {
        ...settings.aiProviders,
        [providerId]: {
          ...prev,
          [field]: value,
        },
      },
    });
  };

  const handleSelectCategory = (id: CategoryId) => {
    setActiveCategory(id);
    if (id !== 'all') {
      const targetEl = containerRef.current?.querySelector(`[data-category-card="${id}"]`);
      if (targetEl && typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };

  const shouldRenderSection = (id: CategoryId) => {
    return activeCategory === 'all' || activeCategory === id;
  };

  return (
    <div ref={containerRef} className="space-y-6">
      <div className="sticky top-0 z-10 -mx-1 bg-[var(--bg-overlay)]/95 px-1 pb-3 backdrop-blur-md">
        <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1">
          {CATEGORY_TABS.map((tab) => {
            const isActive = activeCategory === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleSelectCategory(tab.id)}
                className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                  isActive
                    ? 'bg-[var(--accent)] text-white shadow-xs'
                    : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]'
                }`}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {shouldRenderSection('basic') && (
        <section
          data-category-card="basic"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Folder size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_basic')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_basic_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_folder')}
            description={t('settings.excalidraw_folder_desc')}
          >
            <Input
              value={settings.folder}
              onChange={(e) => update({ folder: e.target.value })}
              placeholder="drawings"
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_template_path')}
            description={t('settings.excalidraw_template_path_desc')}
          >
            <Input
              value={settings.templateFilePath}
              onChange={(e) => update({ templateFilePath: e.target.value })}
              placeholder="drawing-template.md"
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_script_folder')}
            description={t('settings.excalidraw_script_folder_desc')}
          >
            <Input
              value={settings.scriptFolderPath}
              onChange={(e) => update({ scriptFolderPath: e.target.value })}
              placeholder="excalidraw"
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_show_release_notes')}
            description={t('settings.excalidraw_show_release_notes_desc')}
          >
            <Switch
              checked={settings.showReleaseNotes}
              onChange={(val) => update({ showReleaseNotes: val })}
              label={t('settings.excalidraw_show_release_notes')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_compress')}
            description={t('settings.excalidraw_compress_desc')}
          >
            <Switch
              checked={settings.compress}
              onChange={(val) => update({ compress: val })}
              label={t('settings.excalidraw_compress')}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('saving') && (
        <section
          data-category-card="saving"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Save size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_saving')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_saving_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_autosave_interval')}
            description={t('settings.excalidraw_autosave_interval_desc')}
          >
            <Input
              type="number"
              min={200}
              max={5000}
              step={100}
              value={settings.autoSaveIntervalMs}
              onChange={(e) => update({ autoSaveIntervalMs: Number(e.target.value) || 600 })}
              className="w-32 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_filename_prefix')}
            description={t('settings.excalidraw_filename_prefix_desc')}
          >
            <Input
              value={settings.drawingFilenamePrefix}
              onChange={(e) => update({ drawingFilenamePrefix: e.target.value })}
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_filename_date_format')}
            description={t('settings.excalidraw_filename_date_format_desc')}
          >
            <Input
              value={settings.drawingFilenameDateFormat}
              onChange={(e) => update({ drawingFilenameDateFormat: e.target.value })}
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_use_extension')}
            description={t('settings.excalidraw_use_extension_desc')}
          >
            <Switch
              checked={settings.useExcalidrawExtension}
              onChange={(val) => update({ useExcalidrawExtension: val })}
              label={t('settings.excalidraw_use_extension')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_embed_prefix_filename')}
            description={t('settings.excalidraw_embed_prefix_filename_desc')}
          >
            <Switch
              checked={settings.drawingEmbedPrefixWithFilename}
              onChange={(val) => update({ drawingEmbedPrefixWithFilename: val })}
              label={t('settings.excalidraw_embed_prefix_filename')}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('ai') && (
        <section
          data-category-card="ai"
          className="space-y-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Sparkles size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_ai')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_ai_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_ai_enabled')}
            description={t('settings.excalidraw_ai_enabled_desc')}
          >
            <Switch
              checked={settings.aiEnabled}
              onChange={(val) => update({ aiEnabled: val })}
              label={t('settings.excalidraw_ai_enabled')}
            />
          </SettingRow>

          {settings.aiEnabled && (
            <div className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-inset)]/40 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-medium text-[var(--text-secondary)]">
                  {t('settings.excalidraw_ai_provider')}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={handleTestConnection}
                    disabled={testResult.loading}
                    className="h-7 text-xs"
                  >
                    <Zap size={13} className="mr-1" />
                    {testResult.loading
                      ? t('settings.excalidraw_ai_testing')
                      : t('settings.excalidraw_ai_test_conn')}
                  </Button>
                </div>
              </div>

              {testResult.ok !== undefined && !testResult.loading && (
                <div
                  className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs ${
                    testResult.ok
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                  }`}
                >
                  {testResult.ok ? (
                    <>
                      <Check size={14} />
                      <span>
                        {t('settings.excalidraw_ai_test_success')} {t('settings.excalidraw_ai_latency', { ms: testResult.latencyMs ?? 0 })}
                      </span>
                    </>
                  ) : (
                    <span>
                      {t('settings.excalidraw_ai_test_failed')}: {testResult.error}
                    </span>
                  )}
                </div>
              )}

              <div data-setting-title={t('settings.excalidraw_ai_provider')} className="space-y-2 pt-1">
                {Object.entries(PROVIDER_INFO).map(([id, info]) => {
                  const conf = settings.aiProviders[id];
                  const isSelected = settings.aiDefaultProvider === id;
                  const hasKey = Boolean(conf?.apiKey?.trim());
                  const isEditing = editingProvider === id;

                  return (
                    <div
                      key={id}
                      className={`rounded-xl border transition-all ${
                        isSelected
                          ? 'border-[var(--accent)] bg-[var(--bg-surface)] shadow-xs'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-surface)]/60'
                      }`}
                    >
                      <div className="flex items-center justify-between p-3">
                        <div
                          className="cursor-pointer flex-1"
                          onClick={() => update({ aiDefaultProvider: id })}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                              {info.name}
                            </span>
                            {isSelected && (
                              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                                {t('settings.excalidraw_current_default')}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                            {t('settings.excalidraw_type')}: {t(info.typeDescKey)} · {t('settings.excalidraw_api')}:{' '}
                            <span
                              className={hasKey ? 'text-emerald-600 font-medium' : 'text-rose-500 font-medium'}
                            >
                              {hasKey
                                ? t('settings.excalidraw_status_configured')
                                : t('settings.excalidraw_status_not_configured')}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <IconButton
                            label={t('settings.excalidraw_edit_provider')}
                            size="sm"
                            onClick={() => setEditingProvider(isEditing ? null : id)}
                          >
                            <Edit2 size={13} />
                          </IconButton>
                        </div>
                      </div>

                      {isEditing && (
                        <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-inset)]/60 p-3 space-y-3 rounded-b-xl">
                          <div>
                            <label className="block text-[11px] font-medium text-[var(--text-tertiary)] mb-1">
                              {t('settings.excalidraw_ai_base_url')}
                            </label>
                            <Input
                              value={conf?.baseURL || info.defaultBaseURL}
                              onChange={(e) =>
                                handleProviderConfigChange(id, 'baseURL', e.target.value)
                              }
                              placeholder={info.defaultBaseURL}
                              className="text-xs"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-[var(--text-tertiary)] mb-1">
                              {t('settings.excalidraw_ai_api_key')}
                            </label>
                            <Input
                              type="password"
                              value={conf?.apiKey || ''}
                              onChange={(e) =>
                                handleProviderConfigChange(id, 'apiKey', e.target.value)
                              }
                              placeholder="sk-..."
                              className="text-xs"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="pt-2 space-y-4">
                <div data-setting-title={t('settings.excalidraw_ai_model')}>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                    {t('settings.excalidraw_ai_model')}
                  </label>
                  <Input
                    value={settings.aiDefaultTextModel}
                    onChange={(e) => update({ aiDefaultTextModel: e.target.value })}
                    placeholder="deepseek-flash"
                  />
                  <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">
                    {t('settings.excalidraw_ai_model_desc')}
                  </p>
                </div>

                <div data-setting-title={t('settings.excalidraw_ai_image_model')}>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                    {t('settings.excalidraw_ai_image_model')}
                  </label>
                  <Input
                    value={settings.aiDefaultImageModel}
                    onChange={(e) => update({ aiDefaultImageModel: e.target.value })}
                    placeholder="deepseek-flash"
                  />
                  <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">
                    {t('settings.excalidraw_ai_image_model_desc')}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                      {t('settings.excalidraw_ai_max_outgoing')}
                    </label>
                    <Input
                      type="number"
                      value={settings.aiMaxOutgoingTokens || 0}
                      onChange={(e) => update({ aiMaxOutgoingTokens: Number(e.target.value) || 0 })}
                    />
                    <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">
                      {t('settings.excalidraw_ai_max_outgoing_desc')}
                    </p>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                      {t('settings.excalidraw_ai_max_response')}
                    </label>
                    <Input
                      type="number"
                      value={settings.aiMaxResponseTokens || 0}
                      onChange={(e) => update({ aiMaxResponseTokens: Number(e.target.value) || 0 })}
                    />
                    <p className="mt-1 text-[11px] text-[var(--text-quaternary)]">
                      {t('settings.excalidraw_ai_max_response_desc')}
                    </p>
                  </div>
                </div>

                <SettingRow
                  title={t('settings.excalidraw_ai_verbose_logging')}
                  description={t('settings.excalidraw_ai_verbose_logging_desc')}
                >
                  <Switch
                    checked={settings.aiVerboseLogging}
                    onChange={(val) => update({ aiVerboseLogging: val })}
                    label={t('settings.excalidraw_ai_verbose_logging')}
                  />
                </SettingRow>
              </div>
            </div>
          )}
        </section>
      )}

      {shouldRenderSection('ui') && (
        <section
          data-category-card="ui"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Layout size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_ui_behavior')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_ui_behavior_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_match_theme')}
            description={t('settings.excalidraw_match_theme_desc')}
          >
            <Switch
              checked={settings.matchTheme}
              onChange={(val) => update({ matchTheme: val })}
              label={t('settings.excalidraw_match_theme')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_dynamic_styling')}
            description={t('settings.excalidraw_dynamic_styling_desc')}
          >
            <Switch
              checked={settings.dynamicStyling}
              onChange={(val) => update({ dynamicStyling: val })}
              label={t('settings.excalidraw_dynamic_styling')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_lefthanded')}
            description={t('settings.excalidraw_lefthanded_desc')}
          >
            <Switch
              checked={settings.leftHandedMode}
              onChange={(val) => update({ leftHandedMode: val })}
              label={t('settings.excalidraw_lefthanded')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_default_mode')}
            description={t('settings.excalidraw_default_mode_desc')}
          >
            <Segmented
              value={settings.defaultMode}
              onChange={(val) => update({ defaultMode: val as 'normal' | 'zen' | 'view' })}
              options={[
                { value: 'normal', label: t('settings.excalidraw_mode_normal') },
                { value: 'zen', label: t('settings.excalidraw_mode_zen') },
                { value: 'view', label: t('settings.excalidraw_mode_view') },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_grid_mode')}
            description={t('settings.excalidraw_grid_mode_desc')}
          >
            <Switch
              checked={settings.gridModeEnabled}
              onChange={(val) => update({ gridModeEnabled: val })}
              label={t('settings.excalidraw_grid_mode')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_grid_size')}
            description={t('settings.excalidraw_grid_size_desc')}
          >
            <Segmented
              value={String(settings.gridSize)}
              onChange={(val) => update({ gridSize: Number(val) || 20 })}
              options={[
                { value: '10', label: '10px' },
                { value: '20', label: '20px' },
                { value: '40', label: '40px' },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_grid_snap')}
            description={t('settings.excalidraw_grid_snap_desc')}
          >
            <Switch
              checked={settings.gridSnap}
              onChange={(val) => update({ gridSnap: val })}
              label={t('settings.excalidraw_grid_snap')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_disable_double_click_edit')}
            description={t('settings.excalidraw_disable_double_click_edit_desc')}
          >
            <Switch
              checked={settings.disableDoubleClickTextEditing}
              onChange={(val) => update({ disableDoubleClickTextEditing: val })}
              label={t('settings.excalidraw_disable_double_click_edit')}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('links') && (
        <section
          data-category-card="links"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Link2 size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_links')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_links_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_link_brackets')}
            description={t('settings.excalidraw_link_brackets_desc')}
          >
            <Switch
              checked={settings.linkBrackets}
              onChange={(val) => update({ linkBrackets: val })}
              label={t('settings.excalidraw_link_brackets')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_link_prefix')}
            description={t('settings.excalidraw_link_prefix_desc')}
          >
            <Input
              value={settings.linkPrefix}
              onChange={(e) => update({ linkPrefix: e.target.value })}
              placeholder={t('settings.excalidraw_placeholder_emoji')}
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_url_prefix')}
            description={t('settings.excalidraw_url_prefix_desc')}
          >
            <Input
              value={settings.urlPrefix}
              onChange={(e) => update({ urlPrefix: e.target.value })}
              placeholder={t('settings.excalidraw_placeholder_emoji')}
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_link_opacity')}
            description={t('settings.excalidraw_link_opacity_desc')}
          >
            <div className="flex items-center gap-3 w-48">
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={settings.linkIndicatorOpacity}
                onChange={(val) => update({ linkIndicatorOpacity: val })}
                className="flex-1"
              />
              <span className="font-mono text-xs text-[var(--text-secondary)] w-8 text-right">
                {settings.linkIndicatorOpacity.toFixed(2)}
              </span>
            </div>
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_allow_ctrl_click')}
            description={t('settings.excalidraw_allow_ctrl_click_desc')}
          >
            <Switch
              checked={settings.allowCtrlClick}
              onChange={(val) => update({ allowCtrlClick: val })}
              label={t('settings.excalidraw_allow_ctrl_click')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_open_in_adjacent')}
            description={t('settings.excalidraw_open_in_adjacent_desc')}
          >
            <Switch
              checked={settings.openInAdjacentPane}
              onChange={(val) => update({ openInAdjacentPane: val })}
              label={t('settings.excalidraw_open_in_adjacent')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_parse_todo')}
            description={t('settings.excalidraw_parse_todo_desc')}
          >
            <Switch
              checked={settings.parseTODO}
              onChange={(val) => update({ parseTODO: val })}
              label={t('settings.excalidraw_parse_todo')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_todo_prefix')}
            description={t('settings.excalidraw_todo_prefix_desc')}
          >
            <Input
              value={settings.todo}
              onChange={(e) => update({ todo: e.target.value })}
              className="w-48 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_done_prefix')}
            description={t('settings.excalidraw_done_prefix_desc')}
          >
            <Input
              value={settings.done}
              onChange={(e) => update({ done: e.target.value })}
              className="w-48 text-xs"
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('embed_md') && (
        <section
          data-category-card="embed_md"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <FileText size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_embedded_in_md')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_embedded_in_md_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_default_embed_mode')}
            description={t('settings.excalidraw_default_embed_mode_desc')}
          >
            <Segmented
              value={settings.defaultCardEmbedMode}
              onChange={(val) => update({ defaultCardEmbedMode: val as 'interactive' | 'image' })}
              options={[
                { value: 'interactive', label: t('settings.excalidraw_embed_interactive') },
                { value: 'image', label: t('settings.excalidraw_embed_static') },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_embed_card_height')}
            description={t('settings.excalidraw_embed_card_height_desc')}
          >
            <Input
              type="number"
              min={200}
              max={1200}
              step={20}
              value={settings.embedCardHeight}
              onChange={(e) => update({ embedCardHeight: Number(e.target.value) || 520 })}
              className="w-32 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_embed_match_theme')}
            description={t('settings.excalidraw_embed_match_theme_desc')}
          >
            <Switch
              checked={settings.embedMatchTheme}
              onChange={(val) => update({ embedMatchTheme: val })}
              label={t('settings.excalidraw_embed_match_theme')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_export_with_bg')}
            description={t('settings.excalidraw_export_with_bg_desc')}
          >
            <Switch
              checked={settings.exportWithBackground}
              onChange={(val) => update({ exportWithBackground: val })}
              label={t('settings.excalidraw_export_with_bg')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_png_scale')}
            description={t('settings.excalidraw_png_scale_desc')}
          >
            <Segmented
              value={String(settings.pngExportScale)}
              onChange={(val) => update({ pngExportScale: Number(val) || 2 })}
              options={[
                { value: '1', label: '1x' },
                { value: '2', label: '2x' },
                { value: '3', label: '3x' },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_export_padding')}
            description={t('settings.excalidraw_export_padding_desc')}
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={settings.exportPaddingSVG}
              onChange={(e) => update({ exportPaddingSVG: Number(e.target.value) || 10 })}
              className="w-32 text-xs"
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('embed_files') && (
        <section
          data-category-card="embed_files"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <FileBox size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_embedded_files')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_embedded_files_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_md_card_width')}
            description={t('settings.excalidraw_md_card_width_desc')}
          >
            <Input
              type="number"
              min={160}
              max={800}
              step={20}
              value={settings.mdCardWidth}
              onChange={(e) => update({ mdCardWidth: Number(e.target.value) || 280 })}
              className="w-32 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_md_card_height')}
            description={t('settings.excalidraw_md_card_height_desc')}
          >
            <Input
              type="number"
              min={80}
              max={600}
              step={20}
              value={settings.mdCardHeight}
              onChange={(e) => update({ mdCardHeight: Number(e.target.value) || 160 })}
              className="w-32 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_md_one_click_edit')}
            description={t('settings.excalidraw_md_one_click_edit_desc')}
          >
            <Switch
              checked={settings.markdownNodeOneClickEditing}
              onChange={(val) => update({ markdownNodeOneClickEditing: val })}
              label={t('settings.excalidraw_md_one_click_edit')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_pdf_import_scale')}
            description={t('settings.excalidraw_pdf_import_scale_desc')}
          >
            <div className="flex items-center gap-3 w-48">
              <Slider
                min={0.5}
                max={3.0}
                step={0.25}
                value={settings.pdfImportScale}
                onChange={(val) => update({ pdfImportScale: val })}
                className="flex-1"
              />
              <span className="font-mono text-xs text-[var(--text-secondary)] w-8 text-right">
                {`${settings.pdfImportScale.toFixed(2)}x`}
              </span>
            </div>
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_pdf_border_box')}
            description={t('settings.excalidraw_pdf_border_box_desc')}
          >
            <Switch
              checked={settings.pdfBorderBox}
              onChange={(val) => update({ pdfBorderBox: val })}
              label={t('settings.excalidraw_pdf_border_box')}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('extended') && (
        <section
          data-category-card="extended"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <PenTool size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_extended')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_extended_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_num_custom_pens')}
            description={t('settings.excalidraw_num_custom_pens_desc')}
          >
            <Segmented
              value={String(settings.numberOfCustomPens)}
              onChange={(val) => update({ numberOfCustomPens: Number(val) || 0 })}
              options={[
                { value: '0', label: '0' },
                { value: '2', label: '2' },
                { value: '5', label: '5' },
                { value: '10', label: '10' },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_default_stroke_width')}
            description={t('settings.excalidraw_default_stroke_width_desc')}
          >
            <Segmented
              value={String(settings.defaultStrokeWidth)}
              onChange={(val) => update({ defaultStrokeWidth: Number(val) || 1 })}
              options={[
                { value: '1', label: t('settings.excalidraw_stroke_thin') },
                { value: '2', label: t('settings.excalidraw_stroke_medium') },
                { value: '3', label: t('settings.excalidraw_stroke_bold') },
                { value: '4', label: t('settings.excalidraw_stroke_extra') },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_default_fill_style')}
            description={t('settings.excalidraw_default_fill_style_desc')}
          >
            <Segmented
              value={settings.defaultFillStyle}
              onChange={(val) =>
                update({
                  defaultFillStyle: val as 'transparent' | 'semi' | 'solid' | 'cross-hatch',
                })
              }
              options={[
                { value: 'transparent', label: t('settings.excalidraw_fill_transparent') },
                { value: 'semi', label: t('settings.excalidraw_fill_semi') },
                { value: 'solid', label: t('settings.excalidraw_fill_solid') },
                { value: 'cross-hatch', label: t('settings.excalidraw_fill_crosshatch') },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_default_roughness')}
            description={t('settings.excalidraw_default_roughness_desc')}
          >
            <Segmented
              value={String(settings.defaultRoughness)}
              onChange={(val) => update({ defaultRoughness: Number(val) || 1 })}
              options={[
                { value: '0', label: t('settings.excalidraw_roughness_architect') },
                { value: '1', label: t('settings.excalidraw_roughness_artist') },
                { value: '2', label: t('settings.excalidraw_roughness_cartoonist') },
              ]}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('fonts') && (
        <section
          data-category-card="fonts"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Type size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_fonts')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_fonts_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_default_font_family')}
            description={t('settings.excalidraw_default_font_family_desc')}
          >
            <Segmented
              value={String(settings.defaultFontFamily)}
              onChange={(val) => update({ defaultFontFamily: Number(val) || 1 })}
              options={[
                { value: '1', label: t('settings.excalidraw_font_virgil') },
                { value: '2', label: t('settings.excalidraw_font_cascadia') },
                { value: '3', label: t('settings.excalidraw_font_excalifont') },
                { value: '4', label: t('settings.excalidraw_font_cjk') },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_default_font_size')}
            description={t('settings.excalidraw_default_font_size_desc')}
          >
            <Segmented
              value={String(settings.defaultFontSize)}
              onChange={(val) => update({ defaultFontSize: Number(val) || 20 })}
              options={[
                { value: '16', label: '16px' },
                { value: '20', label: '20px' },
                { value: '28', label: '28px' },
                { value: '36', label: '36px' },
              ]}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_load_chinese_fonts')}
            description={t('settings.excalidraw_load_chinese_fonts_desc')}
          >
            <Switch
              checked={settings.loadChineseFonts}
              onChange={(val) => update({ loadChineseFonts: val })}
              label={t('settings.excalidraw_load_chinese_fonts')}
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('misc') && (
        <section
          data-category-card="misc"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Hash size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_misc')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_misc_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_latex_boilerplate')}
            description={t('settings.excalidraw_latex_boilerplate_desc')}
          >
            <Input
              value={settings.latexBoilerplate}
              onChange={(e) => update({ latexBoilerplate: e.target.value })}
              className="w-48 text-xs font-mono"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_latex_font_size')}
            description={t('settings.excalidraw_latex_font_size_desc')}
          >
            <Input
              type="number"
              min={12}
              max={72}
              value={settings.latexFontSize}
              onChange={(e) => update({ latexFontSize: Number(e.target.value) || 24 })}
              className="w-32 text-xs"
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_property_suggestions')}
            description={t('settings.excalidraw_property_suggestions_desc')}
          >
            <Switch
              checked={settings.loadPropertySuggestions}
              onChange={(val) => update({ loadPropertySuggestions: val })}
              label={t('settings.excalidraw_property_suggestions')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_file_tag')}
            description={t('settings.excalidraw_file_tag_desc')}
          >
            <Input
              value={settings.experimentalFileTag}
              onChange={(e) => update({ experimentalFileTag: e.target.value })}
              placeholder="excalidraw"
              className="w-48 text-xs"
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('automate') && (
        <section
          data-category-card="automate"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <Cpu size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_automate')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_automate_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_enable_onload_scripts')}
            description={t('settings.excalidraw_enable_onload_scripts_desc')}
          >
            <Switch
              checked={settings.enableOnloadScripts}
              onChange={(val) => update({ enableOnloadScripts: val })}
              label={t('settings.excalidraw_enable_onload_scripts')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_enable_save_hooks')}
            description={t('settings.excalidraw_enable_save_hooks_desc')}
          >
            <Switch
              checked={settings.enableSaveHooks}
              onChange={(val) => update({ enableSaveHooks: val })}
              label={t('settings.excalidraw_enable_save_hooks')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_startup_script_path')}
            description={t('settings.excalidraw_startup_script_path_desc')}
          >
            <Input
              value={settings.startupScriptPath}
              onChange={(e) => update({ startupScriptPath: e.target.value })}
              placeholder="startup.js"
              className="w-48 text-xs"
            />
          </SettingRow>
        </section>
      )}

      {shouldRenderSection('compatibility') && (
        <section
          data-category-card="compatibility"
          className="space-y-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 p-4 shadow-2xs"
        >
          <div className="border-b border-[var(--border-subtle)] pb-2">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
              <ShieldCheck size={16} className="text-[var(--accent)]" />
              {t('settings.excalidraw_section_compatibility')}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {t('settings.excalidraw_section_compatibility_desc')}
            </p>
          </div>

          <SettingRow
            title={t('settings.excalidraw_compatibility_mode')}
            description={t('settings.excalidraw_compatibility_mode_desc')}
          >
            <Switch
              checked={settings.compatibilityMode}
              onChange={(val) => update({ compatibilityMode: val })}
              label={t('settings.excalidraw_compatibility_mode')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_embed_md_comments')}
            description={t('settings.excalidraw_embed_md_comments_desc')}
          >
            <Switch
              checked={settings.embedMarkdownCommentLinks}
              onChange={(val) => update({ embedMarkdownCommentLinks: val })}
              label={t('settings.excalidraw_embed_md_comments')}
            />
          </SettingRow>

          <SettingRow
            title={t('settings.excalidraw_sync_excalidraw')}
            description={t('settings.excalidraw_sync_excalidraw_desc')}
          >
            <Switch
              checked={settings.syncExcalidraw}
              onChange={(val) => update({ syncExcalidraw: val })}
              label={t('settings.excalidraw_sync_excalidraw')}
            />
          </SettingRow>
        </section>
      )}

      <div className="flex justify-end pt-4 border-t border-[var(--border-subtle)]">
        <Button size="sm" onClick={settings.resetSettings} className="text-xs text-[var(--text-tertiary)]">
          <RotateCcw size={13} className="mr-1.5" />
          {t('settings.excalidraw_reset_defaults')}
        </Button>
      </div>
    </div>
  );
}
