import { t } from '../../../lib/i18n'

export function XgetApp() {
  return (
    <div data-testid="xget-app-root" className="flex h-full min-h-0 items-center justify-center bg-[var(--bg-base)] text-[var(--text-secondary)]">
      {t('development.xget.module_name')}
    </div>
  )
}
