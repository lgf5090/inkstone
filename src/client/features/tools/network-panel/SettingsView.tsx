/**
 * Every switch on this screen writes the same settings row the speed test reads, so a change here is
 * the next test's behaviour rather than a preference this tab shows and forgets. The two ceilings
 * reuse the dialog the speed screen opens; the reset puts every field back to the shipped default.
 */
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { NETWORK_PANEL_LIMITS } from '@shared/tools/network-panel/types'
import { formatBandwidth, formatBytes } from '@shared/tools/network-panel/engine'
import { Button } from '../../../components/primitives'
import { SettingRow, Slider, Switch } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useNetworkPanelStore } from './store'
import { CapDialog } from './components/CapDialog'

export function SettingsView() {
  const settings = useNetworkPanelStore((s) => s.settings)
  const updateSettings = useNetworkPanelStore((s) => s.updateSettings)
  const resetSettings = useNetworkPanelStore((s) => s.resetSettings)
  const saveError = useNetworkPanelStore((s) => s.saveError)
  const flushSettings = useNetworkPanelStore((s) => s.flushSettings)
  const [capKind, setCapKind] = useState<'data' | 'speed' | null>(null)

  const reset = async () => {
    const answer = await confirm({
      title: t('tools.network_panel.settings.reset_confirm'),
      confirmLabel: t('tools.network_panel.settings.reset'),
      cancelLabel: t('common.cancel'),
      tone: 'danger',
    })
    if (answer) await resetSettings()
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="min-w-0">
        <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
          {t('tools.network_panel.settings.title')}
        </h2>
        <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.network_panel.settings.desc')}
        </p>
      </header>

      {saveError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-2.5 text-[length:var(--text-12)] text-[var(--danger)]">
          <span className="min-w-0">{t('tools.network_panel.settings.save_failed')}</span>
          <Button size="sm" variant="secondary" onClick={() => { void flushSettings() }}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <SettingRow
          title={t('tools.network_panel.settings.threads')}
          description={t('tools.network_panel.settings.threads_hint')}
        >
          <div className="min-w-[180px]">
            <Slider
              label={t('tools.network_panel.settings.threads')}
              value={settings.threads}
              min={NETWORK_PANEL_LIMITS.minThreads}
              max={NETWORK_PANEL_LIMITS.maxThreads}
              onChange={(value) => updateSettings({ threads: value })}
            />
          </div>
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.auto_start')}
          description={t('tools.network_panel.settings.auto_start_hint')}
        >
          <Switch
            checked={settings.autoStart}
            label={t('tools.network_panel.settings.auto_start')}
            onChange={(next) => updateSettings({ autoStart: next })}
          />
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.background')}
          description={t('tools.network_panel.settings.background_hint')}
        >
          <Switch
            checked={settings.background}
            label={t('tools.network_panel.settings.background')}
            onChange={(next) => updateSettings({ background: next })}
          />
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.show_chart')}
          description={t('tools.network_panel.settings.show_chart_hint')}
        >
          <Switch
            checked={settings.showChart}
            label={t('tools.network_panel.settings.show_chart')}
            onChange={(next) => updateSettings({ showChart: next })}
          />
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.save_history')}
          description={t('tools.network_panel.settings.save_history_hint')}
        >
          <Switch
            checked={settings.saveHistory}
            label={t('tools.network_panel.settings.save_history')}
            onChange={(next) => updateSettings({ saveHistory: next })}
          />
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.auto_refresh_info')}
          description={t('tools.network_panel.settings.auto_refresh_info_hint')}
        >
          <Switch
            checked={settings.autoRefreshInfo}
            label={t('tools.network_panel.settings.auto_refresh_info')}
            onChange={(next) => updateSettings({ autoRefreshInfo: next })}
          />
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.data_cap')}
          description={t('tools.network_panel.settings.data_cap_hint')}
        >
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">
              {settings.maxDataBytes > 0 ? formatBytes(settings.maxDataBytes) : t('tools.network_panel.cap.unlimited')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setCapKind('data')}>
              {t('common.edit')}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          title={t('tools.network_panel.settings.speed_cap')}
          description={t('tools.network_panel.settings.speed_cap_hint')}
        >
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">
              {settings.maxSpeedBps > 0 ? formatBandwidth(settings.maxSpeedBps) : t('tools.network_panel.cap.unlimited')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setCapKind('speed')}>
              {t('common.edit')}
            </Button>
          </div>
        </SettingRow>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        <div className="min-w-0">
          <h3 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('tools.network_panel.settings.reset')}
          </h3>
          <p className="mt-0.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('tools.network_panel.settings.reset_hint')}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => { void reset() }}>
          {t('tools.network_panel.settings.reset')}
        </Button>
      </section>

      <section className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
        <h3 className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
          {t('tools.network_panel.about.title')}
        </h3>
        <p className="mt-1 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
          {t('tools.network_panel.about.body')}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[length:var(--text-12)]">
          <a
            href="https://github.com/ljxi/NetworkPanel"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
          >
            {t('tools.network_panel.about.source')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <a
            href="https://netart.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
          >
            {t('tools.network_panel.about.author')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </section>

      <CapDialog
        open={capKind !== null}
        kind={capKind ?? 'data'}
        value={capKind === 'speed' ? settings.maxSpeedBps : settings.maxDataBytes}
        onClose={() => setCapKind(null)}
        onApply={(value) => updateSettings(capKind === 'speed' ? { maxSpeedBps: value } : { maxDataBytes: value })}
      />
    </div>
  )
}
