import { useState } from 'react';
import {
  Check,
  Edit2,
  ExternalLink,
  Palette,
  RotateCcw,
  Sliders,
  Sparkles,
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

export function ExcalidrawSettings() {
  const settings = useExcalidrawSettings();
  const update = settings.updateSettings;

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    loading: boolean;
    ok?: boolean;
    latencyMs?: number;
    error?: string;
  }>({ loading: false });

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

  return (
    <div className="space-y-8">

      <section className="space-y-4">
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
            </div>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="border-b border-[var(--border-subtle)] pb-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
            <ExternalLink size={16} className="text-[var(--accent)]" />
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
      </section>

      <section className="space-y-4">
        <div className="border-b border-[var(--border-subtle)] pb-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
            <Sliders size={16} className="text-[var(--accent)]" />
            {t('settings.excalidraw_section_general')}
          </h3>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
            {t('settings.excalidraw_section_general_desc')}
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
      </section>

      <section className="space-y-4">
        <div className="border-b border-[var(--border-subtle)] pb-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-primary)]">
            <Palette size={16} className="text-[var(--accent)]" />
            {t('settings.excalidraw_section_display')}
          </h3>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
            {t('settings.excalidraw_section_display_desc')}
          </p>
        </div>

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
          title={t('settings.excalidraw_lefthanded')}
          description={t('settings.excalidraw_lefthanded_desc')}
        >
          <Switch
            checked={settings.leftHandedMode}
            onChange={(val) => update({ leftHandedMode: val })}
            label={t('settings.excalidraw_lefthanded')}
          />
        </SettingRow>
      </section>

      <div className="flex justify-end pt-4 border-t border-[var(--border-subtle)]">
        <Button size="sm" onClick={settings.resetSettings} className="text-xs text-[var(--text-tertiary)]">
          <RotateCcw size={13} className="mr-1.5" />
          {t('settings.excalidraw_reset_defaults')}
        </Button>
      </div>
    </div>
  );
}
