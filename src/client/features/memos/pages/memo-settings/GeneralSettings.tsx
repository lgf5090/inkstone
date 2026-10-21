import { useId, useState } from 'react'
import type { MemoVisibility } from '@shared/memos/types'
import { MEMO_VISIBILITIES } from '@shared/memos/types'
import { Select, SettingRow, Switch } from '../../../../components/form'
import { t, type MessageKey } from '../../../../lib/i18n'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'
import { settingsErrorMessage } from './error'
import type { MemoSettingsSectionProps } from './types'

const VISIBILITY_KEYS: Record<MemoVisibility, MessageKey> = {
  private: 'memos.visibility.private',
  protected: 'memos.visibility.protected',
  public: 'memos.visibility.public',
}

export function GeneralSettings({ preferences, saving, save }: MemoSettingsSectionProps) {
  const visibilityId = useId()
  const [error, setError] = useState<string | null>(null)

  const update = async (patch: Parameters<MemoSettingsSectionProps['save']>[0]): Promise<void> => {
    setError(null)
    try {
      await save(patch)
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    }
  }

  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.general}
      title={t('memos.settings.general')}
      description={t('memos.settings.general_description')}
    >
      {error ? (
        <div role="alert" className="mb-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-2">
          <p className="text-[length:var(--text-11-5)] font-medium text-[var(--danger)]">
            {t('memos.settings.save_failed')}
          </p>
          <p className="mt-0.5 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
            {error}
          </p>
        </div>
      ) : null}
      <SettingRow
        title={t('memos.settings.default_visibility')}
        description={t('memos.settings.default_visibility_hint')}
        controlId={visibilityId}
      >
        <Select
          id={visibilityId}
          value={preferences.defaultVisibility}
          disabled={saving}
          onChange={(event) => {
            const next = event.target.value
            if ((MEMO_VISIBILITIES as readonly string[]).includes(next)) {
              void update({ defaultVisibility: next as MemoVisibility })
            }
          }}
        >
          {MEMO_VISIBILITIES.map((visibility) => (
            <option key={visibility} value={visibility}>{t(VISIBILITY_KEYS[visibility])}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        title={t('memos.settings.double_click')}
        description={t('memos.settings.double_click_hint')}
      >
        <Switch
          checked={preferences.enableDoubleClickEdit}
          disabled={saving}
          label={t('memos.settings.double_click')}
          onChange={(next) => void update({ enableDoubleClickEdit: next })}
        />
      </SettingRow>
      <SettingRow
        title={t('memos.settings.media_metadata')}
        description={t('memos.settings.media_metadata_hint')}
      >
        <Switch
          checked={preferences.saveMediaMetadata}
          disabled={saving}
          label={t('memos.settings.media_metadata')}
          onChange={(next) => void update({ saveMediaMetadata: next })}
        />
      </SettingRow>
      <SettingRow
        title={t('memos.settings.link_preview')}
        description={t('memos.settings.link_preview_hint')}
      >
        <Switch
          checked={preferences.enableLinkPreview}
          disabled={saving}
          label={t('memos.settings.link_preview')}
          onChange={(next) => void update({ enableLinkPreview: next })}
        />
      </SettingRow>
      <SettingRow
        title={t('memos.settings.reverse_geocoding')}
        description={t('memos.settings.reverse_geocoding_hint')}
      >
        <Switch
          checked={preferences.enableReverseGeocoding}
          disabled={saving}
          label={t('memos.settings.reverse_geocoding')}
          onChange={(next) => void update({ enableReverseGeocoding: next })}
        />
      </SettingRow>
    </SettingsCard>
  )
}
