import { SquareTerminal } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Empty } from '../../components/feedback'

export function WebsshApp() {
  return (
    <div
      data-testid="webssh-app-root"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <SquareTerminal size={16} className="shrink-0 text-[var(--text-secondary)]" />
        <h1 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {t('webssh.app.title')}
        </h1>
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty
          art="notes"
          title={t('webssh.app.empty_title')}
          description={t('webssh.app.empty_description')}
        />
      </main>
    </div>
  )
}
