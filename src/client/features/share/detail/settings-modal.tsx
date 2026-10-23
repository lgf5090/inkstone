import { useState } from 'react';
import { Settings } from 'lucide-react';
import type { ShareTimelineRange } from '@shared/share-hub';
import { Modal } from '../../../components/overlay';
import { Button } from '../../../components/primitives';
import { Segmented, SettingRow } from '../../../components/form';
import { t } from '../../../lib/i18n';
import { useUi } from '../../../store/ui';
import {
  AUTO_REFRESH_MS_OPTIONS,
  SHARE_TIMELINE_RANGES,
  STALE_LINK_DAY_OPTIONS,
  saveShareHubPrefs,
  useShareHubPrefs,
} from './share-prefs';

const MODAL_WIDTH = 520;

/** The window a reading opens on, in the order the picker lists them. */
const RANGE_LABELS: Record<ShareTimelineRange, () => string> = {
  '24h': () => t('share.hub_range_24h'),
  '7d': () => t('share.hub_range_7d'),
  '30d': () => t('share.hub_range_30d'),
  all: () => t('share.hub_range_all'),
};

/**
 * The hub's own reading preferences.
 *
 * Nothing here changes what a visitor sees: the three knobs decide which links the hub calls quiet,
 * how often it re-reads its numbers and which window a timeline opens on. They are kept in this
 * browser, so the hub the next visitor-facing decision is made in remembers the same answers.
 */
export function ShareSettingsModal({ onClose }: { onClose: () => void }) {
  const toast = useUi((s) => s.toast);
  const prefs = useShareHubPrefs();
  const [staleLinkDays, setStaleLinkDays] = useState(String(prefs.staleLinkDays));
  const [autoRefreshMs, setAutoRefreshMs] = useState(String(prefs.autoRefreshMs));
  const [defaultRange, setDefaultRange] = useState<ShareTimelineRange>(prefs.defaultRange);

  function save() {
    saveShareHubPrefs({
      staleLinkDays: Number(staleLinkDays),
      autoRefreshMs: Number(autoRefreshMs),
      defaultRange,
    });
    toast({ title: t('share.hub_saved'), tone: 'success' });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={(
        <span className="flex items-center gap-1.5">
          <Settings size={15} className="text-[var(--accent)]"/>
          {t('share.hub_settings_title')}
        </span>
      )}
      description={t('share.hub_settings_desc')}
      width={MODAL_WIDTH}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="py-1">
        <SettingRow
          title={t('share.hub_stale_threshold')}
          description={t('share.hub_stale_desc')}
          className="md:flex-col md:items-stretch"
        >
          <Segmented
            label={t('share.hub_stale_threshold')}
            value={staleLinkDays}
            onChange={setStaleLinkDays}
            className="w-full"
            options={STALE_LINK_DAY_OPTIONS.map((days) => ({
              value: String(days),
              label: days === 0 ? t('share.hub_off') : t('share.hub_days', { days }),
            }))}
          />
        </SettingRow>
        <SettingRow
          title={t('share.hub_auto_refresh')}
          description={t('share.hub_auto_refresh_desc')}
          className="md:flex-col md:items-stretch"
        >
          <Segmented
            label={t('share.hub_auto_refresh')}
            value={autoRefreshMs}
            onChange={setAutoRefreshMs}
            className="w-full"
            options={AUTO_REFRESH_MS_OPTIONS.map((ms) => ({
              value: String(ms),
              label: ms === 0
                ? t('share.hub_off')
                : ms < 60_000 ? t('share.hub_seconds', { seconds: ms / 1000 }) : t('share.hub_minutes', { minutes: ms / 60_000 }),
            }))}
          />
        </SettingRow>
        <SettingRow
          title={t('share.hub_default_range')}
          description={t('share.hub_default_range_desc')}
          className="md:flex-col md:items-stretch"
        >
          <Segmented
            label={t('share.hub_default_range')}
            value={defaultRange}
            onChange={setDefaultRange}
            className="w-full"
            options={SHARE_TIMELINE_RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range]() }))}
          />
        </SettingRow>
        <p className="pt-3 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
          {t('share.hub_stored_local')}
        </p>
      </div>
    </Modal>
  );
}
