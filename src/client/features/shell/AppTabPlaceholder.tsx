/**
 * The container standing in for an app that has not been written yet.
 *
 * It is deliberately the real frame — header, body, the same tokens the notebook uses — so the
 * day an app lands it replaces this file's own body and nothing about the rail, the address or
 * the layout has to change. It says plainly that there is no app here rather than drawing a
 * picture of one, because a mock is read as a bug the moment a reader tries to use it.
 */
import { t } from '../../lib/i18n'
import { appTab, type AppTabId } from './app-tabs'

export function AppTabPlaceholder({ tabId }: { tabId: AppTabId }) {
  const tab = appTab(tabId)
  const Icon = tab.icon
  const label = t(tab.labelKey)
  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <Icon size={15} />
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-[var(--text-primary)]">{label}</span>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
            <Icon size={24} />
          </span>
          <p className="font-serif text-[16px] font-semibold text-[var(--text-primary)]">{label}</p>
          <p className="text-[13px] leading-relaxed text-[var(--text-tertiary)]">
            {t('app.tabs.placeholder_hint')}
          </p>
        </div>
      </div>
    </section>
  )
}
