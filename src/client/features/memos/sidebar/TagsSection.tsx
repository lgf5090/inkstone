import type { ReactElement } from 'react'
import { SectionLabel } from '../../../components/primitives'
import { t } from '../../../lib/i18n'

export function TagsSection(): ReactElement {
  return (
    <div className="pt-2">
      <SectionLabel>{t('memos.nav.tags')}</SectionLabel>
      <p className="px-2 py-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
        {t('memos.sidebar.tags_placeholder')}
      </p>
    </div>
  )
}
