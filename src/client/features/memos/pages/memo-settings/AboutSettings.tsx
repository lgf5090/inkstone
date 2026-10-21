import { APP_VERSION, GITHUB_REPOSITORY_URL } from '@shared/constants'
import { Logo } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { useSession } from '../../../../store/session'
import { MEMO_SETTINGS_SECTION_IDS } from './sections'
import { SettingsCard } from './SettingsCard'

const MEMOS_PROJECT_URL = 'https://github.com/usememos/memos'

export function AboutSettings() {
  const siteVersion = useSession((state) => state.site?.version)
  const version = siteVersion ?? APP_VERSION
  return (
    <SettingsCard
      id={MEMO_SETTINGS_SECTION_IDS.about}
      title={t('memos.settings.about')}
      description={t('memos.settings.about_tagline')}
    >
      <div className="flex items-center gap-2.5">
        <Logo size={30} />
        <div className="min-w-0">
          <p className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('common.product_name')}
          </p>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('memos.settings.about_version', { version })}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('memos.settings.about_description')}
      </p>
      <p className="mt-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('memos.settings.about_memos_attribution')}
      </p>
      <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
        {t('memos.settings.about_license')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={MEMOS_PROJECT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-10 items-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-0 md:h-7"
        >
          {t('memos.settings.about_memos_link')}
        </a>
        <a
          href={GITHUB_REPOSITORY_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-10 items-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2.5 text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-0 md:h-7"
        >
          {t('memos.settings.about_inkstone_link')}
        </a>
      </div>
    </SettingsCard>
  )
}
