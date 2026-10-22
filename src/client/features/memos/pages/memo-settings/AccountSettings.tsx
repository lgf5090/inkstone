import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'

export function AccountSettings() {
  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.account}
      title={t('memos.settings.account')}
      description={t('memos.settings.account_description')}
    >
      <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('memos.settings.account_appearance')}
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-3"
        onClick={() => useUi.getState().openPanel('settings')}
      >
        {t('memos.settings.account_open')}
      </Button>
    </SettingsCard>
  )
}
